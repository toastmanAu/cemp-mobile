import { Cell, CellOutput, Script, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET, codec, deriveConversationId, deriveRouteTag } from "@cemp/core";
import {
  MessagePublisher,
  MlDsaV2TxSigner,
  RateLimiter,
  DEFAULT_RATE_LIMITS,
  ResponseLifecycle,
  TYPE_ID_CODE_HASH,
  assembleTextMessage,
  assembleTextMessageV3,
  authenticateIncomingV3,
  currentRoutingEpoch,
  openIncoming,
  incomingLogicalMessageId,
  type CempMessageTypeRef,
} from "@cemp/ckb";
import { CempClient, type JsonRpcTransport } from "@cemp/ckb";
import { MockCkbClient, fillHex, hashFromRpcBody, toOutputLike } from "@cemp/ckb/testing";
import {
  deriveIdentityKeys,
  encryptEnvelope,
  mldsaV2KeygenFromSeed,
  mnemonicToSeed,
  randomBytes,
  wipeIdentityKeyBundle,
  type IdentityKeyBundle,
} from "@cemp/crypto";
import {
  AttachmentRepository,
  BalanceRepository,
  ContactRepository,
  ConversationRepository,
  DatabasePublicationStore,
  IncomingDispositionRepository,
  LocalSettingsRepository,
  MessageRepository,
  OutgoingTransactionRepository,
  RateLimitRepository,
  SyncCursorRepository,
  WatchedOutpointRepository,
  WorkerLeaseRepository,
  migrate,
} from "@cemp/database";
import { NodeSqliteAdapter } from "@cemp/database/node";
import type { NotificationContent, Notifier } from "@cemp/ui";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import { InMemoryScheduler, SyncEngine } from "./engine.js";
import { BackoffPolicy } from "./retry.js";
import {
  makeTestResolver,
  testSenderFromKeys,
  withSenderProfiles,
  type TestSender,
} from "./test-helpers.js";
import { upsertAuthenticatedContact } from "./ingest.js";
import { buildWorkerSpecs, ingestIncomingCellData, type SyncWorkerDeps } from "./workers.js";

/**
 * SECURITY PHASE A reproductions through the REAL sync pipeline.
 *
 * Handoff matrix rows AUTH-01, AUTH-02, RCPT-01/02 and TRNS-01 through
 * `ingestIncomingCellData`, the incoming-discovery, response-sender and
 * reclaim-batch workers on the REAL database stack. Content spoofing
 * (AUTH-01/02, TRNS-01 content) is FIXED by ADR 0007 (sender-signed v3
 * envelopes): a forged v3 message is rejected with no row, notification,
 * ack or contact, and a v1/v2 message is labelled "Unverified (legacy)",
 * never notified and never acked. Receipt forgery (RCPT-01/02, TRNS-01
 * receipts) is FIXED by ADR 0006 and those tests assert zero effect; an
 * end-to-end test proves a genuine receipt still works. Nothing is
 * broadcast: the chain transport is a fake.
 *
 * The stack below mirrors `makeStack` in workers.test.ts (not exported),
 * parameterised by WHICH identity owns the device, so the same harness can
 * play Bob (impersonation victim) and Alice (receipt-forgery victim).
 *
 * See docs/review/PHASE-A-REPRODUCTION.md.
 */

function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Deterministic TEST-ONLY identities (BIP39 reference vectors).
const ALICE = deriveIdentityKeys(
  mnemonicToSeed("legal winner thank year wave sausage worth useful legal winner thank yellow"),
);
const BOB = deriveIdentityKeys(
  mnemonicToSeed("letter advice cage absurd amount doctor acoustic avoid letter advice cage above"),
);
const MALLORY = deriveIdentityKeys(new Uint8Array(64).fill(0x4d));
const ALICE_PROFILE_ID = hexToBytes("aa".repeat(32));
const BOB_PROFILE_ID = hexToBytes("bb".repeat(32));
const MALLORY_PROFILE_ID = hexToBytes("4d".repeat(32));
/** Published profiles bound to each identity's ML-DSA lock (ADR 0007 §5). */
const ALICE_SENDER = testSenderFromKeys(ALICE, ALICE_PROFILE_ID, 0x5a);
const BOB_SENDER = testSenderFromKeys(BOB, BOB_PROFILE_ID, 0x5b);
const MALLORY_SENDER = testSenderFromKeys(MALLORY, MALLORY_PROFILE_ID, 0x5c);
const PUBLISHED = [ALICE_SENDER, BOB_SENDER, MALLORY_SENDER];
const MALLORY_DEVICE = hexToBytes("66".repeat(16));
const signerKeyPair = mldsaV2KeygenFromSeed(hexToBytes(vectors.keygen[0]!.seed));

const MESSAGE_TYPE_REF: CempMessageTypeRef = {
  codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
  hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
  cellDep: {
    txHash: CKB_TESTNET.deployments.cempMessageType!.txHash,
    index: "0x0",
    depType: "code",
  },
};

/** Arbitrary output locks: "Alice's" lock and Mallory's own lock. */
const ALICE_LOCK = Script.from({
  codeHash: fillHex(0x77, 32),
  hashType: "type",
  args: `0x${"a1".repeat(37)}`,
});
const MALLORY_LOCK = Script.from({
  codeHash: fillHex(0x77, 32),
  hashType: "type",
  args: `0x${"4d".repeat(37)}`,
});

class RecordingNotifier implements Notifier {
  readonly posted: NotificationContent[] = [];
  post(content: NotificationContent): Promise<void> {
    this.posted.push(content);
    return Promise.resolve();
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

/** Wrap envelope bytes as an indexer message-cell JSON with a chosen output lock. */
function cellJson(
  assembled: {
    routeTag: Uint8Array;
    conversationTag: Uint8Array;
    messageNonce: Uint8Array;
    envelopeBytes: Uint8Array;
  },
  outPointByte: number,
  lock: Script,
): unknown {
  const typeArgs = new Uint8Array(81);
  typeArgs[0] = 1;
  typeArgs.set(assembled.routeTag, 1);
  typeArgs.set(assembled.conversationTag, 33);
  typeArgs.set(assembled.messageNonce, 49);
  return {
    out_point: { tx_hash: fillHex(outPointByte, 32), index: "0x0" },
    output: {
      capacity: `0x${fixedPointFrom(500).toString(16)}`,
      lock: { code_hash: lock.codeHash, hash_type: "type", args: lock.args },
      type: {
        code_hash: MESSAGE_TYPE_REF.codeHash,
        hash_type: MESSAGE_TYPE_REF.hashType,
        args: hexFrom(typeArgs),
      },
    },
    output_data: hexFrom(assembled.envelopeBytes),
    block_number: "0x1",
  };
}

function makeTransport(
  cells: unknown[],
  profileCells: unknown[],
  sent: Record<string, unknown>[],
): JsonRpcTransport {
  return {
    call(_url, method, params) {
      switch (method) {
        case "get_cells": {
          const isProfileQuery =
            (params[0] as { script?: { code_hash?: string } }).script?.code_hash ===
            TYPE_ID_CODE_HASH;
          if (params[3] !== undefined) {
            return Promise.resolve({ objects: [], last_cursor: "0x" });
          }
          return Promise.resolve({
            objects: isProfileQuery ? profileCells : cells,
            last_cursor: "0x",
          });
        }
        case "get_transaction":
          return Promise.resolve({
            tx_status: { status: "committed", block_hash: fillHex(0x99, 32) },
          });
        case "get_header":
          return Promise.resolve({
            number: "0x100",
            epoch: "0x0",
            timestamp: "0x0",
            hash: fillHex(0x99, 32),
          });
        case "send_transaction":
          sent.push(params[0] as Record<string, unknown>);
          return Promise.resolve(hashFromRpcBody(params[0] as Record<string, unknown>));
        case "get_live_cell":
          // The fake chain reports every cell already spent; the batch reclaim
          // therefore marks covered rows reclaimed WITHOUT building a tx (the
          // live-cell reclaim spend is shown in cemp-ckb/receipt-auth.test.ts).
          return Promise.resolve({ cell: null, status: "dead" });
        default:
          return Promise.reject(new Error(`unexpected method ${method}`));
      }
    },
  };
}

function failingTx(inner: JsonRpcTransport, fail: boolean): JsonRpcTransport {
  return {
    call(url, method, params) {
      if (fail && method === "get_transaction") {
        return Promise.reject(new Error("RPC timed out"));
      }
      return inner.call(url, method, params);
    },
  };
}

interface Device {
  profileId: Uint8Array;
  keys: IdentityKeyBundle;
}

async function makeStack(
  device: Device,
  cells: unknown[] = [],
  opts: {
    profileCells?: unknown[];
    fundSigner?: boolean;
    failProfileLookups?: () => boolean;
    /** Override which profiles are published (default: the real three). */
    senders?: readonly TestSender[];
    /** Make every get_transaction fail (funding-lock lookups included). */
    failTransactions?: boolean;
    preDecryptLimits?: { perSync: number; perFundingLock: number };
  } = {},
) {
  const db = new NodeSqliteAdapter();
  await migrate(db);
  const contacts = new ContactRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  const outgoingTxs = new OutgoingTransactionRepository(db);
  const attachments = new AttachmentRepository(db);
  const watchedOutpoints = new WatchedOutpointRepository(db);
  const balances = new BalanceRepository(db);
  const cursors = new SyncCursorRepository(db);
  const leases = new WorkerLeaseRepository(db);
  const localSettings = new LocalSettingsRepository(db);
  const rateLimiter = new RateLimiter(new RateLimitRepository(db), { ...DEFAULT_RATE_LIMITS });
  const walletId = await balances.ensureWallet("main");
  const store = new DatabasePublicationStore(messages, outgoingTxs, {
    watchedOutpoints,
    balances,
    walletId,
    attachments,
  });
  const sent: Record<string, unknown>[] = [];
  const client = new CempClient({
    transport: withSenderProfiles(
      failingTx(
        makeTransport(cells, opts.profileCells ?? [], sent),
        opts.failTransactions === true,
      ),
      opts.senders ?? PUBLISHED,
      {
        ...(opts.failProfileLookups === undefined
          ? {}
          : { failProfileLookups: opts.failProfileLookups }),
      },
    ),
  });
  const wallet = new MockCkbClient();
  const signer = new MlDsaV2TxSigner({ keyPair: signerKeyPair, client: wallet });
  if (opts.fundSigner === true) {
    wallet.addCells(
      Cell.from({
        outPoint: { txHash: fillHex(0xf1, 32), index: 0 },
        cellOutput: toOutputLike(
          CellOutput.from({ capacity: fixedPointFrom(100_000), lock: signer.lockScript() }),
        ),
        outputData: "0x",
      }),
    );
  }
  const lifecycle = new ResponseLifecycle({ client, signer, messageType: MESSAGE_TYPE_REF, store });
  const publisher = new MessagePublisher({
    client,
    signer,
    messageType: MESSAGE_TYPE_REF,
    store,
    senderProfileId: () => Promise.resolve(device.profileId),
    senderDeviceId: hexToBytes("02".repeat(16)),
    envelopeSigningKey: () => Promise.resolve(device.keys.mlDsa),
  });
  const notifier = new RecordingNotifier();
  const walletLockScript = signer.lockScript();
  const reclaimGroupCalls: { reclaimGroupId: Uint8Array; outpoints: readonly unknown[] }[] = [];
  const deps: SyncWorkerDeps = {
    client,
    messageType: MESSAGE_TYPE_REF,
    lifecycle,
    publisher,
    messages,
    contacts,
    conversations,
    outgoingTxs,
    attachments,
    cursors,
    leases,
    balances,
    rateLimiter,
    senderResolver: makeTestResolver(client, contacts),
    dispositions: new IncomingDispositionRepository(db),
    ...(opts.preDecryptLimits === undefined ? {} : { preDecryptLimits: opts.preDecryptLimits }),
    walletId,
    walletLock: {
      codeHash: walletLockScript.codeHash,
      hashType: walletLockScript.hashType,
      args: walletLockScript.args,
    },
    notifier,
    engineId: "engine-auth-test",
    ownProfileId: () => Promise.resolve(device.profileId),
    ownKemSecretKey: device.keys.mlKem.secretKey,
    localSettings,
    reclaimAttachmentGroup: (input) => {
      reclaimGroupCalls.push(input);
      return Promise.resolve(null);
    },
  };
  const engine = new SyncEngine({
    scheduler: new InMemoryScheduler(),
    leases,
    cursors,
    workers: buildWorkerSpecs(deps),
    backoff: new BackoffPolicy({ jitter: 0 }),
    engineId: "engine-auth-test",
  });
  return {
    db,
    engine,
    deps,
    notifier,
    rateLimiter,
    messages,
    contacts,
    conversations,
    attachments,
    balances,
    outgoingTxs,
    walletId,
    reclaimGroupCalls,
    sent,
  };
}

type Stack = Awaited<ReturnType<typeof makeStack>>;

const BOB_DEVICE: Device = { profileId: BOB_PROFILE_ID, keys: BOB };
const ALICE_DEVICE: Device = { profileId: ALICE_PROFILE_ID, keys: ALICE };

/**
 * Mallory's v3 impersonation: she claims Alice's PUBLIC id and encrypts to
 * Bob's PUBLIC KEM key, but can only sign with her OWN ML-DSA key.
 */
function mallorySignsAsAliceToBob(text: string) {
  return assembleTextMessageV3({
    text,
    senderProfileId: ALICE_PROFILE_ID,
    signerSecretKey: MALLORY.mlDsa.secretKey,
    signerPublicKey: MALLORY.mlDsa.publicKey,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: MALLORY_DEVICE,
    receiptRequest: 1,
  });
}

/** Mallory's unsigned legacy (v2) impersonation — what Phase A reproduced. */
function malloryLegacySpoofsAliceToBob(text: string) {
  return assembleTextMessage({
    text,
    senderProfileId: ALICE_PROFILE_ID,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: MALLORY_DEVICE,
    receiptRequest: 1,
  });
}

/** A genuine v3 message from Alice to Bob. */
function aliceSignsToBob(text: string) {
  return assembleTextMessageV3({
    text,
    senderProfileId: ALICE_PROFILE_ID,
    signerSecretKey: ALICE.mlDsa.secretKey,
    signerPublicKey: ALICE.mlDsa.publicKey,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: hexToBytes("01".repeat(16)),
    receiptRequest: 1,
  });
}

/** Bob already knows Alice (contact + conversation). Returns that conversation id. */
async function bobKnowsAlice(stack: Stack, pinned = false): Promise<number> {
  const alice = await stack.contacts.create({
    displayName: "Alice",
    profileIdHex: bytesToHex(ALICE_PROFILE_ID),
  });
  if (pinned) {
    await stack.contacts.setProfileSecurity(alice.id, {
      profileTypeIdHex: bytesToHex(ALICE_PROFILE_ID),
      mlDsaPublicKey: ALICE.mlDsa.publicKey,
      mlKemPublicKey: ALICE.mlKem.publicKey,
      fingerprint: "test",
      trustVerdict: "trusted",
    });
  }
  return (await stack.conversations.getOrCreateForContact(alice.id)).id;
}

async function rowFor(stack: Stack, messageId: Uint8Array) {
  return stack.messages.getByLogicalId(incomingLogicalMessageId(messageId));
}

async function queuedAcks(stack: Stack): Promise<number> {
  return (await stack.messages.listByState(["queued"])).filter((m) =>
    m.logicalMessageId.startsWith("response:"),
  ).length;
}

/** Nothing at all happened on Bob's device. */
async function expectNoTrace(stack: Stack, messageId: Uint8Array, contactsBefore: number) {
  expect(await rowFor(stack, messageId)).toBeUndefined();
  expect(await stack.contacts.list()).toHaveLength(contactsBefore);
  expect(stack.notifier.posted).toHaveLength(0);
  expect(await queuedAcks(stack)).toBe(0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── AUTH-01 / AUTH-02 / TRNS-01: impersonation ─────────────────────────── */

describe("FIXED (ADR 0007): AUTH-01 spoofed sender (chain discovery)", () => {
  for (const pinned of [true, false]) {
    it(`a v3 cell claiming Alice but signed by Mallory is rejected: no row, contact, notification or ack (Alice ${pinned ? "pinned" : "known, unpinned"})`, async () => {
      const forged = mallorySignsAsAliceToBob("it's alice. new address, please pay here");
      const stack = await makeStack(BOB_DEVICE, [cellJson(forged, 0xe1, MALLORY_LOCK)]);
      try {
        await bobKnowsAlice(stack, pinned);
        expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
        await expectNoTrace(stack, forged.messageId, 1);
        expect(
          (await stack.deps.dispositions.get({ txHash: fillHex(0xe1, 32), outpointIndex: 0 }))
            ?.disposition,
        ).toBe("rejected");
      } finally {
        await stack.db.close();
      }
    });
  }

  it("a v3 forgery claiming an id Bob has never seen creates no contact", async () => {
    const forged = mallorySignsAsAliceToBob("hello stranger");
    const stack = await makeStack(BOB_DEVICE, [cellJson(forged, 0xe8, MALLORY_LOCK)]);
    try {
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      await expectNoTrace(stack, forged.messageId, 0);
    } finally {
      await stack.db.close();
    }
  });

  it("control: Alice's genuine v3 message is received, verified, notified and auto-acked", async () => {
    const genuine = aliceSignsToBob("hi bob");
    const stack = await makeStack(BOB_DEVICE, [cellJson(genuine, 0xe9, ALICE_LOCK)]);
    try {
      const conversationId = await bobKnowsAlice(stack, true);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      const row = await rowFor(stack, genuine.messageId);
      expect(row?.state).toBe("received");
      expect(row?.conversationId).toBe(conversationId);
      expect(row?.authStatus).toBe("verified");
      expect(row?.senderKeyHashHex).toMatch(/^[0-9a-f]{64}$/);
      expect(stack.notifier.posted).toHaveLength(1);
      expect(await queuedAcks(stack)).toBe(1);
    } finally {
      await stack.db.close();
    }
  });

  it("legacy v2 spoof: labelled Unverified (legacy) in Alice's conversation, never notified, never acked", async () => {
    const forged = malloryLegacySpoofsAliceToBob("legacy spoof");
    const stack = await makeStack(BOB_DEVICE, [cellJson(forged, 0xea, MALLORY_LOCK)]);
    try {
      await bobKnowsAlice(stack, true);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      const row = await rowFor(stack, forged.messageId);
      expect(row?.authStatus).toBe("legacy-unverified");
      expect(row?.senderKeyHashHex).toBeNull();
      expect(stack.notifier.posted).toHaveLength(0);
      expect(await queuedAcks(stack)).toBe(0);
    } finally {
      await stack.db.close();
    }
  });

  it("legacy v2 content claiming an unknown sender is not stored and creates no contact", async () => {
    const forged = malloryLegacySpoofsAliceToBob("legacy to a stranger");
    const stack = await makeStack(BOB_DEVICE, [cellJson(forged, 0xeb, MALLORY_LOCK)]);
    try {
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      await expectNoTrace(stack, forged.messageId, 0);
    } finally {
      await stack.db.close();
    }
  });

  it("forged traffic does not consume Alice's per-sender rate budget (limiter keys on the authenticated sender)", async () => {
    const forgeries = Array.from({ length: 5 }, (_, i) => mallorySignsAsAliceToBob(`spam ${i}`));
    const stack = await makeStack(
      BOB_DEVICE,
      forgeries.map((f, i) => cellJson(f, 0x30 + i, MALLORY_LOCK)),
    );
    try {
      await bobKnowsAlice(stack, true);
      const before = await stack.rateLimiter.available("incoming", bytesToHex(ALICE_PROFILE_ID));
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await stack.rateLimiter.available("incoming", bytesToHex(ALICE_PROFILE_ID))).toBe(
        before,
      );
    } finally {
      await stack.db.close();
    }
  });

  it("a blocked AUTHENTICATED sender is dropped even with a valid signature", async () => {
    const genuine = aliceSignsToBob("blocked");
    const stack = await makeStack(BOB_DEVICE, [cellJson(genuine, 0xec, ALICE_LOCK)]);
    try {
      await bobKnowsAlice(stack, true);
      const alice = await stack.contacts.getByProfileId(bytesToHex(ALICE_PROFILE_ID));
      await stack.contacts.setBlocked(alice!.id, true);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await rowFor(stack, genuine.messageId)).toBeUndefined();
      expect(stack.notifier.posted).toHaveLength(0);
    } finally {
      await stack.db.close();
    }
  });
});

describe("FIXED (ADR 0007): AUTH-02 output lock is not sender proof — the signature is", () => {
  it("forgeries under Alice's lock and under Mallory's lock are both rejected; a genuine cell under Mallory's lock is accepted", async () => {
    const underAliceLock = mallorySignsAsAliceToBob("under alice's lock");
    const underMalloryLock = mallorySignsAsAliceToBob("under mallory's lock");
    const genuineOddLock = aliceSignsToBob("genuine, odd output lock");
    const stack = await makeStack(BOB_DEVICE, [
      cellJson(underAliceLock, 0xe2, ALICE_LOCK),
      cellJson(underMalloryLock, 0xe3, MALLORY_LOCK),
      cellJson(genuineOddLock, 0xed, MALLORY_LOCK),
    ]);
    try {
      await bobKnowsAlice(stack, true);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await rowFor(stack, underAliceLock.messageId)).toBeUndefined();
      expect(await rowFor(stack, underMalloryLock.messageId)).toBeUndefined();
      expect((await rowFor(stack, genuineOddLock.messageId))?.authStatus).toBe("verified");
    } finally {
      await stack.db.close();
    }
  });
});

describe("FIXED (ADR 0007): TRNS-01 identical bytes via CKB and via LoRa (source: null)", () => {
  it("a forgery is rejected on both transports", async () => {
    const forgedHex = bytesToHex(
      mallorySignsAsAliceToBob("same bytes, two transports").envelopeBytes,
    );
    const chain = await makeStack(BOB_DEVICE);
    const lora = await makeStack(BOB_DEVICE);
    try {
      await bobKnowsAlice(chain, true);
      await bobKnowsAlice(lora, true);
      await ingestIncomingCellData(chain.deps, BOB_PROFILE_ID, forgedHex, {
        txHash: fillHex(0xe4, 32),
        outpointIndex: 0,
      });
      await ingestIncomingCellData(lora.deps, BOB_PROFILE_ID, forgedHex, null);
      for (const s of [chain, lora]) {
        expect(await s.messages.listByState(["received"])).toHaveLength(0);
        expect(s.notifier.posted).toHaveLength(0);
      }
    } finally {
      await chain.db.close();
      await lora.db.close();
    }
  });

  it("a genuine message is verified on both; only the chain path queues an ack", async () => {
    const genuine = aliceSignsToBob("genuine, two transports");
    const hex = bytesToHex(genuine.envelopeBytes);
    const chain = await makeStack(BOB_DEVICE);
    const lora = await makeStack(BOB_DEVICE);
    try {
      await bobKnowsAlice(chain, true);
      await bobKnowsAlice(lora, true);
      await ingestIncomingCellData(chain.deps, BOB_PROFILE_ID, hex, {
        txHash: fillHex(0xee, 32),
        outpointIndex: 0,
      });
      await ingestIncomingCellData(lora.deps, BOB_PROFILE_ID, hex, null);
      expect((await rowFor(chain, genuine.messageId))?.authStatus).toBe("verified");
      expect((await rowFor(lora, genuine.messageId))?.authStatus).toBe("verified");
      expect(await queuedAcks(chain)).toBe(1);
      expect(await queuedAcks(lora)).toBe(0);
    } finally {
      await chain.db.close();
      await lora.db.close();
    }
  });
});

describe("ADR 0007 receive pipeline: blocking card, healer, dispositions, brand", () => {
  it("pinned key no longer matches the live profile: a body-less blocking card, never notified or acked", async () => {
    // Alice's profile id now publishes MALLORY's key (an unprovable in-place
    // key change); Bob pinned Alice's real key. Mallory signs with hers.
    const hijacked = testSenderFromKeys(MALLORY, ALICE_PROFILE_ID, 0x5d);
    const forged = mallorySignsAsAliceToBob("trust me, new key");
    const stack = await makeStack(BOB_DEVICE, [cellJson(forged, 0x61, MALLORY_LOCK)], {
      senders: [hijacked, BOB_SENDER],
    });
    try {
      const conversationId = await bobKnowsAlice(stack, true);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      const row = await rowFor(stack, forged.messageId);
      expect(row?.authStatus).toBe("key-changed-blocking");
      expect(row?.body).toBeNull();
      expect(row?.conversationId).toBe(conversationId);
      expect(stack.notifier.posted).toHaveLength(0);
      expect(await queuedAcks(stack)).toBe(0);
    } finally {
      await stack.db.close();
    }
  });

  it("the stranded-row healer never notifies or acks a legacy-unverified row", async () => {
    const stack = await makeStack(BOB_DEVICE);
    try {
      const conversationId = await bobKnowsAlice(stack, true);
      const row = await stack.messages.insert({
        conversationId,
        direction: "incoming",
        body: "legacy, interrupted",
        logicalMessageId: "incoming:legacy-stranded",
      });
      await stack.messages.setSenderAuthentication(row.id, {
        authStatus: "legacy-unverified",
        senderKeyHashHex: null,
      });
      await stack.messages.transitionState(row.id, "downloading");
      await stack.messages.setChainRef(row.id, { txHash: fillHex(0x62, 32), outpointIndex: 0 });
      expect(await stack.engine.runWorker("pending-transactions")).toBe("success");
      expect((await stack.messages.getById(row.id))?.state).toBe("received");
      expect(stack.notifier.posted).toHaveLength(0);
      expect(await queuedAcks(stack)).toBe(0);
    } finally {
      await stack.db.close();
    }
  });

  it("a rejected cell is terminal: later scans do not decrypt or resolve it again", async () => {
    const forged = mallorySignsAsAliceToBob("reject me once");
    const stack = await makeStack(BOB_DEVICE, [cellJson(forged, 0x63, MALLORY_LOCK)]);
    try {
      await bobKnowsAlice(stack, true);
      let resolves = 0;
      const inner = stack.deps.senderResolver;
      (stack.deps as { senderResolver: typeof inner }).senderResolver = {
        resolve: (opened) => {
          resolves += 1;
          return inner.resolve(opened);
        },
      };
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      const afterFirst = resolves;
      expect(afterFirst).toBe(1);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(resolves).toBe(afterFirst);
    } finally {
      await stack.db.close();
    }
  });

  it("a funding-lock lookup failure defers the cell before any decryption", async () => {
    const genuine = aliceSignsToBob("arrives while the node is flaky");
    const stack = await makeStack(BOB_DEVICE, [cellJson(genuine, 0x64, ALICE_LOCK)], {
      failTransactions: true,
    });
    try {
      await bobKnowsAlice(stack, true);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await rowFor(stack, genuine.messageId)).toBeUndefined();
      expect(
        (await stack.deps.dispositions.get({ txHash: fillHex(0x64, 32), outpointIndex: 0 }))
          ?.disposition,
      ).toBe("deferred");
    } finally {
      await stack.db.close();
    }
  });

  it("contact upsert refuses anything but a verifier-made AuthenticatedIncoming", async () => {
    const stack = await makeStack(BOB_DEVICE);
    try {
      const opened = openIncoming({
        cellData: aliceSignsToBob("brand").envelopeBytes,
        ownKemSecretKey: BOB.mlKem.secretKey,
        ownProfileId: BOB_PROFILE_ID,
      });
      if (opened.kind !== "v3") throw new Error("expected v3");
      const outcome = await authenticateIncomingV3(opened.unverified, stack.deps.senderResolver);
      if (outcome.kind !== "authenticated")
        throw new Error(`expected authenticated, got ${outcome.kind}`);
      const copy = { ...outcome.message };
      await expect(upsertAuthenticatedContact(stack.contacts, copy)).rejects.toThrow(
        /verifier-made/,
      );
      expect(await stack.contacts.list()).toHaveLength(0);
      const created = await upsertAuthenticatedContact(stack.contacts, outcome.message);
      expect(created.displayName).toBe(`unknown-${bytesToHex(ALICE_PROFILE_ID).slice(0, 8)}`);
    } finally {
      await stack.db.close();
    }
  });
});

describe("ADR 0007 receive pipeline: deferral and pre-decryption budgets", () => {
  it("a profile-lookup failure defers (never shown or acked) and the cell is retried after backoff", async () => {
    const genuine = aliceSignsToBob("arrives while the indexer is down");
    let indexerDown = true;
    const stack = await makeStack(BOB_DEVICE, [cellJson(genuine, 0xef, ALICE_LOCK)], {
      failProfileLookups: () => indexerDown,
    });
    try {
      await bobKnowsAlice(stack, false); // unpinned: the live profile is needed
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      await expectNoTrace(stack, genuine.messageId, 1);
      const key = { txHash: fillHex(0xef, 32), outpointIndex: 0 };
      const deferred = await stack.deps.dispositions.get(key);
      expect(deferred?.disposition).toBe("deferred");

      // Indexer back, but still inside the backoff window: not retried yet.
      indexerDown = false;
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await rowFor(stack, genuine.messageId)).toBeUndefined();

      // After the backoff: retried, verified, shown.
      const later = deferred!.nextAttemptAtMs + 1;
      vi.spyOn(Date, "now").mockReturnValue(later);
      await ingestIncomingCellData(
        stack.deps,
        BOB_PROFILE_ID,
        bytesToHex(genuine.envelopeBytes),
        key,
      );
      expect((await rowFor(stack, genuine.messageId))?.authStatus).toBe("verified");
    } finally {
      await stack.db.close();
    }
  });

  it("the per-funding-lock budget bounds work per tick; the rest stays untouched for the next tick", async () => {
    const messages = [aliceSignsToBob("one"), aliceSignsToBob("two"), aliceSignsToBob("three")];
    const stack = await makeStack(
      BOB_DEVICE,
      messages.map((m, i) => cellJson(m, 0x40 + i, ALICE_LOCK)),
      { preDecryptLimits: { perSync: 100, perFundingLock: 2 } },
    );
    try {
      await bobKnowsAlice(stack, true);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await stack.messages.listByState(["received"])).toHaveLength(2);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await stack.messages.listByState(["received"])).toHaveLength(3);
    } finally {
      await stack.db.close();
    }
  });

  it("the global per-sync budget bounds work across funding locks", async () => {
    const messages = [aliceSignsToBob("a"), aliceSignsToBob("b"), aliceSignsToBob("c")];
    const stack = await makeStack(
      BOB_DEVICE,
      messages.map((m, i) => cellJson(m, 0x50 + i, ALICE_LOCK)),
      { preDecryptLimits: { perSync: 1, perFundingLock: 100 } },
    );
    try {
      await bobKnowsAlice(stack, true);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await stack.messages.listByState(["received"])).toHaveLength(1);
    } finally {
      await stack.db.close();
    }
  });
});

/* ── RCPT-01 / RCPT-02 / TRNS-01: forged receipts reach the lifecycle ───── */

const RECLAIM_GROUP_ID = new Uint8Array(16).fill(0x26);

function testManifest(): codec.AttachmentManifestV1Encodable {
  return {
    attachment_id: new Uint8Array(16).fill(0x11),
    ckbfs_root: { tx_hash: new Uint8Array(32).fill(0x22), index: 0 },
    chunk_outpoints: [
      { tx_hash: new Uint8Array(32).fill(0x22), index: 0 },
      { tx_hash: new Uint8Array(32).fill(0x22), index: 1 },
    ],
    encrypted_size: 4096n,
    plaintext_size: 3800n,
    mime_type: new TextEncoder().encode("image/webp"),
    width: 640,
    height: 480,
    thumbnail: undefined,
    content_hash: new Uint8Array(32).fill(0xc1),
    cipher_hash: new Uint8Array(32).fill(0xc2),
    encryption_nonce: new Uint8Array(12).fill(0x0c),
    encryption_algorithm: { family: 0x03, parameter: 1 },
    reclaim_group_id: RECLAIM_GROUP_ID,
  };
}

const CELL_SHANNON = fixedPointFrom(500);
const ALICE_MESSAGE_TX = fillHex(0xa1, 32);

/**
 * Alice's device state: one genuine outgoing image message to Bob, committed
 * on-chain, its capacity reserved. Returns the genuine published envelope
 * (what any chain observer can read) and the row id.
 */
function alicePublishesImageToBob() {
  return assembleTextMessageV3({
    text: "",
    contentType: 0x03,
    attachmentManifests: [testManifest()],
    senderProfileId: ALICE_PROFILE_ID,
    signerSecretKey: ALICE.mlDsa.secretKey,
    signerPublicKey: ALICE.mlDsa.publicKey,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: hexToBytes("01".repeat(16)),
    receiptRequest: 1,
  });
}

async function aliceHasPendingImageToBob(
  stack: Stack,
  published: ReturnType<typeof alicePublishesImageToBob> = alicePublishesImageToBob(),
) {
  const bob = await stack.contacts.create({
    displayName: "Bob",
    profileIdHex: bytesToHex(BOB_PROFILE_ID),
  });
  const conv = await stack.conversations.getOrCreateForContact(bob.id);
  const row = await stack.messages.insert({
    conversationId: conv.id,
    direction: "outgoing",
    body: null,
    logicalMessageId: "lm-alice-image",
    state: "available_on_chain",
  });
  await stack.messages.setEnvelopeMessageId(row.id, bytesToHex(published.messageId));
  // ADR 0006: the publisher stores the sender's receipt key before broadcast.
  await stack.messages.setReceiptKey(row.id, published.receiptKey);
  await stack.messages.setChainRef(row.id, { txHash: ALICE_MESSAGE_TX, outpointIndex: 0 });
  await stack.attachments.create({
    messageId: row.id,
    kind: "image",
    byteLength: 3800,
    manifest: codec.encodeAttachmentManifestV1(testManifest()),
  });
  // Publication journal + capacity reservation (what the publish monitor records).
  await stack.outgoingTxs.record({
    txHash: ALICE_MESSAGE_TX,
    purpose: "message:lm-alice-image",
    state: "committed",
    capacityShannon: CELL_SHANNON.toString(),
  });
  await stack.balances.setChainBalances(
    stack.walletId,
    fixedPointFrom(10_000),
    fixedPointFrom(10_000),
  );
  await stack.balances.reserveCapacity(stack.walletId, CELL_SHANNON);
  return { published, rowId: row.id };
}

/**
 * Mallory forges Bob's receipts. A v3 envelope no longer shows the message
 * id or the parties in clear text, so this GRANTS Mallory the message id
 * (a stronger attacker than the chain allows) and has her claim to be Bob.
 * Two forms: an unsigned legacy v2 ack (its proof is a guess) and a v3 ack
 * signed with her own key.
 */
function malloryForgesBobReceipts(messageId: Uint8Array, form: "v2" | "v3" = "v2") {
  const common = {
    text: "",
    senderProfileId: BOB_PROFILE_ID,
    recipientProfileId: ALICE_PROFILE_ID,
    recipientKemPublicKey: ALICE.mlKem.publicKey,
    senderDeviceId: MALLORY_DEVICE,
    // Receipts need a proof under Alice→Bob's receipt key, which only Alice
    // and Bob can derive: Mallory can only guess.
    receipts: [
      { messageId, status: 0x01, proof: randomBytes(32) },
      { messageId, status: 0x05, proof: randomBytes(32) },
    ],
  };
  return form === "v2"
    ? assembleTextMessage(common)
    : assembleTextMessageV3({
        ...common,
        signerSecretKey: MALLORY.mlDsa.secretKey,
        signerPublicKey: MALLORY.mlDsa.publicKey,
      });
}

async function expectUntouched(stack: Stack, rowId: number): Promise<void> {
  expect((await stack.messages.getById(rowId))?.state).toBe("available_on_chain");
  const balance = await stack.balances.getBalance(stack.walletId);
  expect(balance.reservedShannon).toBe(CELL_SHANNON);
  expect(balance.reclaimableShannon).toBe(0n);
  expect((await stack.attachments.listForMessage(rowId))[0]?.remoteDownloaded).toBe(false);
}

describe("FIXED (ADR 0006): RCPT-01/02 forged receipts through the sync pipeline", () => {
  it("chain discovery: forged 0x01+0x05 have no effect — no state, no capacity, chunk gate shut, nothing reclaimed", async () => {
    const stack = await makeStack(ALICE_DEVICE);
    try {
      const { published, rowId } = await aliceHasPendingImageToBob(stack);
      for (const [i, form] of (["v2", "v3"] as const).entries()) {
        const forged = malloryForgesBobReceipts(published.messageId, form);
        await ingestIncomingCellData(
          stack.deps,
          ALICE_PROFILE_ID,
          bytesToHex(forged.envelopeBytes),
          { txHash: fillHex(0xe5, 32), outpointIndex: i },
        );
      }

      await expectUntouched(stack, rowId);
      expect(await stack.messages.listByState(["received"])).toHaveLength(0);
      expect(await stack.engine.runWorker("reclaim-batch")).toBe("success");
      expect((await stack.messages.getById(rowId))?.state).toBe("available_on_chain");
      expect(stack.reclaimGroupCalls).toHaveLength(0);
    } finally {
      await stack.db.close();
    }
  });

  it("incoming-discovery worker: the forged receipt cell is found by Alice's PUBLIC route tag but ignored", async () => {
    const published = alicePublishesImageToBob();
    const forged = malloryForgesBobReceipts(published.messageId);
    expect(forged.routeTag).toEqual(deriveRouteTag(ALICE_PROFILE_ID, currentRoutingEpoch()));
    const stack = await makeStack(ALICE_DEVICE, [cellJson(forged, 0xe6, MALLORY_LOCK)]);
    try {
      const { rowId } = await aliceHasPendingImageToBob(stack, published);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      await expectUntouched(stack, rowId);
    } finally {
      await stack.db.close();
    }
  });

  it("TRNS-01 receipts: the same forged receipt bytes via LoRa (source: null) are ignored on both transports", async () => {
    const chain = await makeStack(ALICE_DEVICE);
    const lora = await makeStack(ALICE_DEVICE);
    try {
      const published = alicePublishesImageToBob();
      const c = await aliceHasPendingImageToBob(chain, published);
      const loraRow = (await aliceHasPendingImageToBob(lora, published)).rowId;
      const forgedHex = bytesToHex(malloryForgesBobReceipts(published.messageId).envelopeBytes);
      await ingestIncomingCellData(chain.deps, ALICE_PROFILE_ID, forgedHex, {
        txHash: fillHex(0xe7, 32),
        outpointIndex: 0,
      });
      await ingestIncomingCellData(lora.deps, ALICE_PROFILE_ID, forgedHex, null);
      await expectUntouched(chain, c.rowId);
      await expectUntouched(lora, loraRow);
    } finally {
      await chain.db.close();
      await lora.db.close();
    }
  });
});

/* ── ADR 0006 end to end: a GENUINE receipt still releases capacity ─────── */

/** Alice's on-chain profile cell, so Bob's real publisher can encrypt to her. */
function aliceProfileCellJson(): unknown {
  return ALICE_SENDER.profileCellJson;
}

/** The message-cell data of every message Bob's device broadcast. */
function broadcastEnvelopes(stack: Stack): string[] {
  return stack.sent.map((body) => (body as { outputs_data: string[] }).outputs_data[0]!);
}

describe("ADR 0006 end to end: Bob's real acks via the real response sender", () => {
  it("Alice→Bob image; Bob's device auto-acks (0x01) and confirms the download (0x05); Alice accepts both and reclaims message + chunks", async () => {
    const published = alicePublishesImageToBob();
    const bob = await makeStack(BOB_DEVICE, [cellJson(published, 0xa1, ALICE_LOCK)], {
      profileCells: [aliceProfileCellJson()],
      fundSigner: true,
    });
    const alice = await makeStack(ALICE_DEVICE);
    try {
      // Bob: discover → verify → ingest (stores HIS receipt key) → auto-ack queued.
      await bobKnowsAlice(bob, true);
      expect(await bob.engine.runWorker("incoming-discovery")).toBe("success");
      const original = await rowFor(bob, published.messageId);
      expect(original?.state).toBe("received");
      expect(original?.authStatus).toBe("verified");
      const bobKey = await bob.messages.getReceiptKey(original!.id);
      expect(Array.from(bobKey!)).toEqual(Array.from(published.receiptKey));
      // Bob taps to download: the app queues the 0x05 confirmation the same
      // way MessagingService#queueAttachmentAck does.
      const ack5 = await bob.messages.insert({
        conversationId: original!.conversationId,
        direction: "outgoing",
        body: "",
        logicalMessageId: `ack-attachment:${original!.logicalMessageId}`,
        state: "queued",
      });
      await bob.messages.setChainRef(ack5.id, {
        replyToTxHash: ALICE_MESSAGE_TX,
        replyToOutpointIndex: 0,
      });

      // The REAL response sender proves both receipts and publishes them.
      await bob.balances.setChainBalances(
        bob.walletId,
        fixedPointFrom(100_000),
        fixedPointFrom(100_000),
      );
      expect(await bob.engine.runWorker("response-sender")).toBe("success");
      const envelopes = broadcastEnvelopes(bob);
      expect(envelopes).toHaveLength(2);

      // Alice: her pending image row, then Bob's two broadcast acks arrive.
      const { rowId } = await aliceHasPendingImageToBob(alice, published);
      for (const [i, envelope] of envelopes.entries()) {
        await ingestIncomingCellData(alice.deps, ALICE_PROFILE_ID, envelope, {
          txHash: fillHex(0xb0 + i, 32),
          outpointIndex: 0,
        });
      }
      expect((await alice.messages.getById(rowId))?.state).toBe("reclaim_queued");
      const balance = await alice.balances.getBalance(alice.walletId);
      expect(balance.reservedShannon).toBe(0n);
      expect(balance.reclaimableShannon).toBe(CELL_SHANNON);
      expect((await alice.attachments.listForMessage(rowId))[0]?.remoteDownloaded).toBe(true);
      expect(await alice.engine.runWorker("reclaim-batch")).toBe("success");
      expect((await alice.messages.getById(rowId))?.state).toBe("reclaimed");
      expect(alice.reclaimGroupCalls).toHaveLength(1);
    } finally {
      await bob.db.close();
      await alice.db.close();
    }
  });

  it("a v1 original is legacy: labelled, no receipt key, no ack queued, nothing sent", async () => {
    // A legacy v1 message from Alice: decrypts and displays with the
    // "Unverified (legacy)" label (ADR 0007 §8) and is never auto-acked.
    const messageId = hexToBytes("71".repeat(16));
    const payload = codec.encodeCempPayloadV1({
      message_id: messageId,
      body_type: 0x01,
      recipient_profile_id: BOB_PROFILE_ID,
      text: new TextEncoder().encode("hello from an old build"),
      attachment_manifests: [],
      reply_to_message_id: undefined,
      reply_to_outpoint: undefined,
      receipts: [],
      receipt_request: 1,
      client_timestamp: 1n,
      sender_device_id: hexToBytes("01".repeat(16)),
      padding: new Uint8Array(0),
    });
    const envelope = encryptEnvelope({
      payload,
      recipientKemPublicKey: BOB.mlKem.publicKey,
      header: {
        protocol_version: 1,
        network: 0x01,
        content_type: 0x01,
        message_id: messageId,
        conversation_id: deriveConversationId(ALICE_PROFILE_ID, BOB_PROFILE_ID),
        sender_profile_id: ALICE_PROFILE_ID,
        created_at_client: 1n,
        reply_to_message_id: undefined,
        expiry_hint: 0n,
      },
    }).envelopeBytes;
    const bob = await makeStack(BOB_DEVICE, [], {
      profileCells: [aliceProfileCellJson()],
      fundSigner: true,
    });
    try {
      await bobKnowsAlice(bob);
      await ingestIncomingCellData(bob.deps, BOB_PROFILE_ID, bytesToHex(envelope), {
        txHash: fillHex(0xc1, 32),
        outpointIndex: 0,
      });
      const row = await rowFor(bob, messageId);
      expect(row?.state).toBe("received");
      expect(row?.body).toBe("hello from an old build");
      expect(row?.authStatus).toBe("legacy-unverified");
      expect(bob.notifier.posted).toHaveLength(0);
      expect(await bob.messages.getReceiptKey(row!.id)).toBeNull();

      // Funded exactly like the end-to-end test, so a send WOULD succeed.
      await bob.balances.setChainBalances(
        bob.walletId,
        fixedPointFrom(100_000),
        fixedPointFrom(100_000),
      );
      expect(await bob.engine.runWorker("response-sender")).toBe("success");
      expect(bob.sent).toHaveLength(0);
      expect(await queuedAcks(bob)).toBe(0);
    } finally {
      await bob.db.close();
    }
  });
});

afterAll(() => {
  wipeIdentityKeyBundle(ALICE);
  wipeIdentityKeyBundle(BOB);
  wipeIdentityKeyBundle(MALLORY);
});
