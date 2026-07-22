import { Script, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET } from "@cemp/core";
import {
  MessagePublisher,
  ResponseLifecycle,
  assembleTextMessage,
  currentRoutingEpoch,
  incomingLogicalMessageId,
  type CempMessageTypeRef,
} from "@cemp/ckb";
import { CempClient, type JsonRpcTransport } from "@cemp/ckb";
import { MockCkbClient, fillHex, hashFromRpcBody } from "@cemp/ckb/testing";
import { deriveIdentityKeys, mldsaV2KeygenFromSeed, mnemonicToSeed } from "@cemp/crypto";
import {
  BalanceRepository,
  ContactRepository,
  ConversationRepository,
  DatabasePublicationStore,
  MessageRepository,
  OutgoingTransactionRepository,
  RateLimitRepository,
  SyncCursorRepository,
  WatchedOutpointRepository,
  WorkerLeaseRepository,
  migrate,
} from "@cemp/database";
import { RateLimiter, DEFAULT_RATE_LIMITS } from "@cemp/ckb";
import { NodeSqliteAdapter } from "@cemp/database/node";
import type { NotificationContent, Notifier } from "@cemp/ui";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import { InMemoryScheduler, SyncEngine } from "./engine.js";
import { BackoffPolicy } from "./retry.js";
import { EndpointRotator } from "./endpoints.js";
import { buildWorkerSpecs, type SyncWorkerDeps } from "./workers.js";

/**
 * Phase 9 worker end-to-end (offline): background discovery, dedup,
 * pending-tx completion, reboot continuity, lease-gated reclaim, endpoint
 * rotation. Real DB stack + real assembly; fake chain transport.
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

const BOB = deriveIdentityKeys(
  mnemonicToSeed("letter advice cage absurd amount doctor acoustic avoid letter advice cage above"),
);
const BOB_PROFILE_ID = hexToBytes("bb".repeat(32));
const ALICE_PROFILE_ID = hexToBytes("aa".repeat(32));
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

/** Wrap an assembled envelope as an indexer message-cell JSON (alice → bob). */
function assembledCellJson(
  assembled: ReturnType<typeof assembleTextMessage>,
  outPointByte = 0xd1,
): { json: unknown; messageId: Uint8Array } {
  const typeArgs = new Uint8Array(81);
  typeArgs[0] = 1;
  typeArgs.set(assembled.routeTag, 1);
  typeArgs.set(assembled.conversationTag, 33);
  typeArgs.set(assembled.messageNonce, 49);
  const lock = Script.from({
    codeHash: fillHex(0x77, 32),
    hashType: "type",
    args: `0x${"42".repeat(37)}`,
  });
  return {
    messageId: assembled.messageId,
    json: {
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
    },
  };
}

/** A discovered message cell addressed to Bob (alice → bob), indexer JSON. */
function discoveryCellJson(
  text: string,
  messageId?: Uint8Array,
): { json: unknown; messageId: Uint8Array } {
  return assembledCellJson(
    assembleTextMessage({
      text,
      senderProfileId: ALICE_PROFILE_ID,
      recipientProfileId: BOB_PROFILE_ID,
      recipientKemPublicKey: BOB.mlKem.publicKey,
      senderDeviceId: hexToBytes("01".repeat(16)),
      receiptRequest: 0,
      ...(messageId === undefined ? {} : { messageId }),
    }),
  );
}

/** A receipt-only ack cell (empty body + 0x01 receipts) addressed to Bob. */
function receiptOnlyCellJson(receipts: readonly { messageId: Uint8Array; status: number }[]): {
  json: unknown;
  messageId: Uint8Array;
} {
  return assembledCellJson(
    assembleTextMessage({
      text: "",
      senderProfileId: ALICE_PROFILE_ID,
      recipientProfileId: BOB_PROFILE_ID,
      recipientKemPublicKey: BOB.mlKem.publicKey,
      senderDeviceId: hexToBytes("01".repeat(16)),
      receiptRequest: 0,
      receipts,
    }),
    0xd2,
  );
}

function makeTransport(cells: unknown[]): JsonRpcTransport {
  return {
    call(_url, method, params) {
      switch (method) {
        case "get_cells":
          // First page only: a follow-up call with an `after` cursor (params[3])
          // returns the empty page, so pagination terminates.
          if (params[3] !== undefined) {
            return Promise.resolve({ objects: [], last_cursor: "0x64" });
          }
          return Promise.resolve({ objects: cells, last_cursor: "0x64" });
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
          return Promise.resolve({ cell: null, status: "dead" });
        default:
          return Promise.reject(new Error(`unexpected method ${method}`));
      }
    },
  };
}

interface Stack {
  db: NodeSqliteAdapter;
  engine: SyncEngine;
  deps: SyncWorkerDeps;
  notifier: RecordingNotifier;
  messages: MessageRepository;
  contacts: ContactRepository;
  conversations: ConversationRepository;
  outgoingTxs: OutgoingTransactionRepository;
  leases: WorkerLeaseRepository;
  cursors: SyncCursorRepository;
}

async function makeStack(
  opts: {
    cells?: unknown[];
    db?: NodeSqliteAdapter;
    engineId?: string;
    ownProfileId?: Uint8Array;
    transport?: JsonRpcTransport;
  } = {},
): Promise<Stack> {
  const db = opts.db ?? new NodeSqliteAdapter();
  await migrate(db);
  const contacts = new ContactRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  const outgoingTxs = new OutgoingTransactionRepository(db);
  const watchedOutpoints = new WatchedOutpointRepository(db);
  const balances = new BalanceRepository(db);
  const cursors = new SyncCursorRepository(db);
  const leases = new WorkerLeaseRepository(db);
  const rateLimiter = new RateLimiter(new RateLimitRepository(db), { ...DEFAULT_RATE_LIMITS });
  const walletId = await balances.ensureWallet("main");
  const store = new DatabasePublicationStore(messages, outgoingTxs, {
    watchedOutpoints,
    balances,
    walletId,
  });

  const client = new CempClient({ transport: opts.transport ?? makeTransport(opts.cells ?? []) });
  const mockChain = new MockCkbClient();
  const signer = new (await import("@cemp/ckb")).MlDsaV2TxSigner({
    keyPair: signerKeyPair,
    client: mockChain,
  });
  const lifecycle = new ResponseLifecycle({ client, signer, messageType: MESSAGE_TYPE_REF, store });
  const publisher = new MessagePublisher({
    client,
    signer,
    messageType: MESSAGE_TYPE_REF,
    store,
    senderProfileId: BOB_PROFILE_ID,
    senderDeviceId: hexToBytes("02".repeat(16)),
  });
  const notifier = new RecordingNotifier();
  const engineId = opts.engineId ?? "engine-test";
  const walletLockScript = signer.lockScript();
  const deps: SyncWorkerDeps = {
    client,
    messageType: MESSAGE_TYPE_REF,
    lifecycle,
    publisher,
    messages,
    contacts,
    conversations,
    outgoingTxs,
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
    engineId,
    ownProfileId: opts.ownProfileId ?? BOB_PROFILE_ID,
    ownKemSecretKey: BOB.mlKem.secretKey,
  };
  const engine = new SyncEngine({
    scheduler: new InMemoryScheduler(),
    leases,
    cursors,
    workers: buildWorkerSpecs(deps),
    backoff: new BackoffPolicy({ jitter: 0 }),
    engineId,
  });
  return {
    db,
    engine,
    deps,
    notifier,
    messages,
    contacts,
    conversations,
    outgoingTxs,
    leases,
    cursors,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("incoming-discovery worker (exit criterion 1)", () => {
  it("discovers, decrypts, inserts, notifies — and a second run does not duplicate", async () => {
    const { json, messageId } = discoveryCellJson("background hello");
    const stack = await makeStack({ cells: [json] });
    try {
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      const contact = (await stack.contacts.list())[0]!;
      expect(contact.displayName.startsWith("unknown-")).toBe(true);
      const conv = (await stack.conversations.listWithPreview())[0]!;
      expect(conv.lastMessageBody).toBe("background hello");
      const stored = await stack.messages.getByLogicalId(incomingLogicalMessageId(messageId));
      expect(stored?.state).toBe("received");
      expect(stored?.envelopeMessageIdHex).toBe(bytesToHex(messageId));
      expect(stack.notifier.posted).toHaveLength(1);
      const posted = stack.notifier.posted[0]!;
      expect(posted.channel).toBe("messages");
      // Security-hardened (no OS-setting-dependent redaction): the posted
      // notification must never carry the sender's identity or the decrypted
      // message text, so a lock screen can never leak either. It stays
      // generic and prompts the user to unlock the app instead.
      expect(posted.title).not.toBe(contact.displayName);
      expect(posted.title).not.toContain(contact.displayName);
      expect(posted.body).not.toBe("background hello");
      expect(posted.body).not.toContain("background hello");
      expect(posted.title).toBe("CellSend");
      expect(posted.body).toBe("New message. Unlock to view.");
      // Discovery persists NO cursor: the indexer orders a prefix search by the
      // type args, which end in a random nonce, so a resumed scan can skip a
      // newly published cell forever (see the sorts-BEFORE test above).
      const epoch = currentRoutingEpoch();
      const bobHex = bytesToHex(BOB_PROFILE_ID);
      expect(
        await stack.cursors.get(`incoming-discovery:${epoch.toString()}:${bobHex}`),
      ).toBeNull();
      expect(
        await stack.cursors.get(`incoming-discovery:${(epoch - 1n).toString()}:${bobHex}`),
      ).toBeNull();

      // Duplicate run (e.g. WorkManager fires twice): no duplicate chat row,
      // no duplicate notification (exit criterion 3).
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await stack.messages.listByState(["received"])).toHaveLength(1);
      expect(stack.notifier.posted).toHaveLength(1);
    } finally {
      await stack.db.close();
    }
  });

  it("skips a cell another engine holds the outpoint lease for (task 9)", async () => {
    const { json } = discoveryCellJson("leased cell");
    const stack = await makeStack({ cells: [json] });
    try {
      const lease = await stack.leases.acquire(
        `outpoint:${fillHex(0xd1, 32)}:0x0`,
        "engine-rival",
        60_000,
      );
      expect(lease).not.toBeNull();
      await stack.engine.runWorker("incoming-discovery");
      expect(await stack.messages.listByState(["received"])).toHaveLength(0);
      expect(stack.notifier.posted).toHaveLength(0);
    } finally {
      await stack.db.close();
    }
  });

  it("a cursor left by a different profile never skips this profile's cells", async () => {
    // On-device find: a first sync ran before the profile existed (zero id)
    // and advanced the epoch cursor; the post-publish sync then resumed the
    // REAL profile's scan from that global position and silently skipped the
    // waiting cell. Cursors are now keyed per profile id.
    const dir = await mkdtemp(join(tmpdir(), "cemp-sync-cursor-"));
    tempDirs.push(dir);
    const path = join(dir, "sync.sqlite");
    const other = await makeStack({
      db: new NodeSqliteAdapter({ path }),
      ownProfileId: new Uint8Array(32),
    });
    await other.engine.runWorker("incoming-discovery");
    await other.db.close();

    const { json } = discoveryCellJson("waiting for me");
    const mine = await makeStack({ db: new NodeSqliteAdapter({ path }), cells: [json] });
    try {
      expect(await mine.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await mine.messages.listByState(["received"])).toHaveLength(1);
    } finally {
      await mine.db.close();
    }
  });

  it("a terminal (empty-page) cursor is never persisted, so a later cell is still found", async () => {
    // On-device find: the real CKB indexer returns last_cursor "0x" for an
    // exhausted scan, and a follow-up get_cells with after:"0x" returns nothing
    // EVEN ONCE a matching cell exists. Persisting that terminal cursor (from a
    // first, empty pre-message sync) silently poisoned discovery forever. The
    // shared makeTransport mock hid this by always returning "0x64"; this
    // transport models the real indexer so the regression is caught off-device.
    const base = makeTransport([]);
    let waiting: unknown[] = [];
    const realisticIndexer: JsonRpcTransport = {
      call(url, method, params) {
        if (method === "get_cells") {
          // after any real position OR the terminal "0x" -> the scan is done.
          if (params[3] !== undefined) return Promise.resolve({ objects: [], last_cursor: "0x" });
          if (waiting.length === 0) return Promise.resolve({ objects: [], last_cursor: "0x" });
          return Promise.resolve({ objects: waiting, last_cursor: "0x64" });
        }
        return base.call(url, method, params);
      },
    };

    const dir = await mkdtemp(join(tmpdir(), "cemp-sync-poison-"));
    tempDirs.push(dir);
    const path = join(dir, "sync.sqlite");

    // Sync 1: no cell yet (device unlocked before the reply was published).
    const first = await makeStack({
      db: new NodeSqliteAdapter({ path }),
      transport: realisticIndexer,
    });
    expect(await first.engine.runWorker("incoming-discovery")).toBe("success");
    await first.db.close();

    // The reply now waits on-chain, addressed to this profile.
    waiting = [discoveryCellJson("waiting after an empty sync").json];

    const second = await makeStack({
      db: new NodeSqliteAdapter({ path }),
      transport: realisticIndexer,
    });
    try {
      expect(await second.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await second.messages.listByState(["received"])).toHaveLength(1);
    } finally {
      await second.db.close();
    }
  });

  it("heals a cursor already poisoned with a terminal '0x' on-device", async () => {
    // Recovery path for devices that already persisted "0x" before the fix: a
    // stored terminal cursor must be treated as a fresh scan, not replayed as
    // `after` (which the indexer answers with nothing, forever).
    const base = makeTransport([]);
    const waiting = [discoveryCellJson("recovered after poison").json];
    const transport: JsonRpcTransport = {
      call(url, method, params) {
        if (method === "get_cells") {
          if (params[3] !== undefined) return Promise.resolve({ objects: [], last_cursor: "0x" });
          return Promise.resolve({ objects: waiting, last_cursor: "0x64" });
        }
        return base.call(url, method, params);
      },
    };
    const stack = await makeStack({ transport });
    try {
      // Pre-poison exactly as the pre-fix worker would have on a first empty sync.
      const epoch = currentRoutingEpoch();
      const bobHex = bytesToHex(BOB_PROFILE_ID);
      await stack.cursors.set(`incoming-discovery:${epoch.toString()}:${bobHex}`, "0x");
      await stack.cursors.set(`incoming-discovery:${(epoch - 1n).toString()}:${bobHex}`, "0x");

      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await stack.messages.listByState(["received"])).toHaveLength(1);
    } finally {
      await stack.db.close();
    }
  });

  it("discovers a cell that sorts BEFORE the previous scan's cursor", async () => {
    // The message type args end in a RANDOM 32-byte nonce and the indexer orders
    // a prefix search BY THOSE ARGS — so a newly published cell sorts
    // arbitrarily, very often before a cursor stored by an earlier scan.
    // Resuming from a persisted cursor then skips that cell forever. Verified
    // live: a committed cell at the right route tag was never discovered, while
    // a cursorless scan always returned it.
    const base = makeTransport([]);
    let cells: unknown[] = [discoveryCellJson("first", hexToBytes("11".repeat(16))).json];
    const orderedIndexer: JsonRpcTransport = {
      call(url, method, params) {
        if (method === "get_cells") {
          // A resumed scan only ever yields what sorts AFTER the cursor — and
          // the late arrival does not.
          if (params[3] !== undefined) return Promise.resolve({ objects: [], last_cursor: "0x" });
          return Promise.resolve({ objects: cells, last_cursor: "0xaa" });
        }
        return base.call(url, method, params);
      },
    };

    const dir = await mkdtemp(join(tmpdir(), "cemp-sync-order-"));
    tempDirs.push(dir);
    const path = join(dir, "sync.sqlite");

    const first = await makeStack({
      db: new NodeSqliteAdapter({ path }),
      transport: orderedIndexer,
    });
    expect(await first.engine.runWorker("incoming-discovery")).toBe("success");
    expect(await first.messages.listByState(["received"])).toHaveLength(1);
    await first.db.close();

    // A second message is published; it sorts BEFORE the first scan's cursor.
    cells = [...cells, discoveryCellJson("late arrival", hexToBytes("22".repeat(16))).json];

    const second = await makeStack({
      db: new NodeSqliteAdapter({ path }),
      transport: orderedIndexer,
    });
    try {
      expect(await second.engine.runWorker("incoming-discovery")).toBe("success");
      expect(await second.messages.listByState(["received"])).toHaveLength(2);
    } finally {
      await second.db.close();
    }
  });

  it("auto-acks a received content message with a hidden queued response (ADR 0005)", async () => {
    const { json, messageId } = discoveryCellJson("ping");
    const stack = await makeStack({ cells: [json] });
    try {
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      // The content message is received and shown.
      const received = await stack.messages.listByState(["received"]);
      expect(received).toHaveLength(1);
      // Exactly one receipt-only response is queued: outgoing, empty body,
      // logical id response:<original>, with a replyTo chain ref to the cell.
      const queuedResponses = (await stack.messages.listByState(["queued"])).filter(
        (m) => m.direction === "outgoing" && m.logicalMessageId.startsWith("response:"),
      );
      expect(queuedResponses).toHaveLength(1);
      const r = queuedResponses[0]!;
      expect(r.body ?? "").toBe("");
      expect(r.logicalMessageId).toBe(`response:${incomingLogicalMessageId(messageId)}`);
      const ref = await stack.messages.getChainRef(r.id);
      expect(ref?.replyToTxHash).toBe(fillHex(0xd1, 32));
      expect(ref?.replyToOutpointIndex).toBe(0);
      // The ack row is never shown as a chat bubble.
      const shown = await stack.messages.listByConversation(received[0]!.conversationId, {
        limit: 50,
      });
      expect(shown.some((m) => m.logicalMessageId.startsWith("response:"))).toBe(false);
      // Idempotent: a second discovery does not queue a second response.
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      expect(
        (await stack.messages.listByState(["queued"])).filter((m) =>
          m.logicalMessageId.startsWith("response:"),
        ),
      ).toHaveLength(1);
    } finally {
      await stack.db.close();
    }
  });

  it("a receipt-only ack advances our outgoing message, no bubble, no re-ack (ADR 0005)", async () => {
    const envId = hexToBytes("cd".repeat(16)); // envelope message ids are 16 bytes
    const { json } = receiptOnlyCellJson([{ messageId: envId, status: 0x01 }]);
    const stack = await makeStack({ cells: [json] });
    try {
      // Seed one of OUR outgoing messages, on-chain, awaiting acknowledgement.
      const contact = await stack.contacts.create({
        displayName: "peer",
        profileIdHex: bytesToHex(ALICE_PROFILE_ID),
      });
      const conversation = await stack.conversations.getOrCreateForContact(contact.id);
      const mine = await stack.messages.insert({
        conversationId: conversation.id,
        direction: "outgoing",
        body: "sent earlier",
        logicalMessageId: "lm-outgoing-1",
        state: "available_on_chain",
      });
      await stack.messages.setEnvelopeMessageId(mine.id, bytesToHex(envId));

      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");

      // The ack advanced our message through delivered → read → reclaim_queued.
      expect((await stack.messages.getById(mine.id))?.state).toBe("reclaim_queued");
      // No chat bubble was created for the receipt-only cell.
      expect(await stack.messages.listByState(["received"])).toHaveLength(0);
      // And a pure ack is never itself acked (no loop).
      expect(
        (await stack.messages.listByState(["queued"])).filter((m) =>
          m.logicalMessageId.startsWith("response:"),
        ),
      ).toHaveLength(0);
    } finally {
      await stack.db.close();
    }
  });
});

describe("pending-transactions worker (exit criterion 2)", () => {
  it("completes a journaled tx across a 'reboot' (new engine, same database file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cemp-sync-reboot-"));
    tempDirs.push(dir);
    const path = join(dir, "sync.sqlite");
    const first = await makeStack({ db: new NodeSqliteAdapter({ path }) });
    const conv = await first.conversations.getOrCreateForContact(
      (await first.contacts.create({ displayName: "alice" })).id,
    );
    const message = await first.messages.insert({
      conversationId: conv.id,
      direction: "outgoing",
      body: "in flight",
      logicalMessageId: "lm-reboot",
    });
    for (const state of [
      "queued",
      "encrypting",
      "building_transaction",
      "awaiting_signature",
      "submitting",
      "pending",
    ] as const) {
      await first.messages.transitionState(message.id, state);
    }
    await first.outgoingTxs.record({
      txHash: fillHex(0xee, 32),
      purpose: "message:lm-reboot",
      state: "submitted",
    });
    await first.db.close(); // "reboot"

    const second = await makeStack({
      db: new NodeSqliteAdapter({ path }),
      engineId: "engine-after-reboot",
    });
    try {
      expect(await second.engine.runWorker("pending-transactions")).toBe("success");
      expect((await second.messages.getById(message.id))?.state).toBe("available_on_chain");
      expect((await second.outgoingTxs.getByTxHash(fillHex(0xee, 32)))?.state).toBe("committed");
    } finally {
      await second.db.close();
    }
  });

  it("heals a message stranded at pending behind an already-committed tx", async () => {
    // The publish monitor marks the outgoing tx `committed` BEFORE advancing the
    // message; an interruption (background/lock/kill) between those two writes
    // leaves the message at `pending` with a `committed` tx. The `submitted`
    // scan never revisits a committed tx, so without a heal the message is
    // stuck at "sent" forever and can never be acknowledged. Found live.
    const stack = await makeStack();
    try {
      const conv = await stack.conversations.getOrCreateForContact(
        (await stack.contacts.create({ displayName: "alice" })).id,
      );
      const message = await stack.messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "stranded",
        logicalMessageId: "lm-strand",
      });
      for (const s of [
        "queued",
        "encrypting",
        "building_transaction",
        "awaiting_signature",
        "submitting",
        "pending",
      ] as const) {
        await stack.messages.transitionState(message.id, s);
      }
      await stack.outgoingTxs.record({
        txHash: fillHex(0xab, 32),
        purpose: "message:lm-strand",
        state: "committed",
      });

      expect(await stack.engine.runWorker("pending-transactions")).toBe("success");
      expect((await stack.messages.getById(message.id))?.state).toBe("available_on_chain");
    } finally {
      await stack.db.close();
    }
  });

  it("applies a receipt to a message that is still pending when the pass starts", async () => {
    // runAllNow drains workers in REGISTRATION ORDER. With incoming-discovery
    // ahead of pending-transactions, a receipt arriving for a not-yet-ackable
    // (pending) message is skipped by processAcknowledgements AND its cell is
    // consumed by the discovery cursor — permanently losing the ack, so the
    // message can never reach delivered/read. Found live on-device.
    const envId = hexToBytes("ef".repeat(16));
    const { json } = receiptOnlyCellJson([{ messageId: envId, status: 0x01 }]);
    const stack = await makeStack({ cells: [json] });
    try {
      const contact = await stack.contacts.create({
        displayName: "peer",
        profileIdHex: bytesToHex(ALICE_PROFILE_ID),
      });
      const conv = await stack.conversations.getOrCreateForContact(contact.id);
      const mine = await stack.messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "awaiting ack",
        logicalMessageId: "lm-order",
        state: "pending",
      });
      await stack.messages.setEnvelopeMessageId(mine.id, bytesToHex(envId));
      // Its tx already committed (the monitor was interrupted before advancing
      // the row), so pending-transactions must make it ack-able THIS pass.
      await stack.outgoingTxs.record({
        txHash: fillHex(0xcd, 32),
        purpose: "message:lm-order",
        state: "committed",
      });

      await stack.engine.runAllNow();

      expect((await stack.messages.getById(mine.id))?.state).toBe("reclaim_queued");
    } finally {
      await stack.db.close();
    }
  });
});

describe("reclaim-batch worker (task 10)", () => {
  it("does not run while another engine holds the reclaim lease", async () => {
    const stack = await makeStack();
    try {
      await stack.leases.acquire("reclaim:batch", "engine-rival", 60_000);
      expect(await stack.engine.runWorker("reclaim-batch")).toBe("success"); // lease skip = clean no-op
      expect(await stack.outgoingTxs.listByState("submitted")).toHaveLength(0); // nothing built/journaled
    } finally {
      await stack.db.close();
    }
  });
});

describe("EndpointRotator (task 7)", () => {
  it("rotates after the failure threshold and persists the choice", async () => {
    const db = new NodeSqliteAdapter();
    await migrate(db);
    try {
      const cursors = new SyncCursorRepository(db);
      const endpoints = [
        { rpc: "https://a.example", indexer: "https://a.example" },
        { rpc: "https://b.example", indexer: "https://b.example" },
      ];
      const rotator = new EndpointRotator(endpoints, cursors, 3);
      expect((await rotator.current()).rpc).toBe("https://a.example");
      expect(await rotator.reportFailure()).toBe(false);
      expect(await rotator.reportFailure()).toBe(false);
      expect(await rotator.reportFailure()).toBe(true); // rotated
      expect((await rotator.current()).rpc).toBe("https://b.example");

      // A fresh rotator over the same DB keeps the rotated choice (persisted).
      const reloaded = new EndpointRotator(endpoints, cursors, 3);
      expect((await reloaded.current()).rpc).toBe("https://b.example");
    } finally {
      await db.close();
    }
  });
});

describe("hardening: spam, replay, blocked senders, rate limits (Phase 11 tasks 7–10)", () => {
  it("route-tag spam: invalid cells are skipped, valid ones processed", async () => {
    const valid = discoveryCellJson("real message in spam flood");
    const spamCells = [
      {
        out_point: { tx_hash: fillHex(0xe1, 32), index: "0x0" },
        output: {
          capacity: "0x100",
          lock: { code_hash: fillHex(0x77, 32), hash_type: "type", args: "0x" },
          type: (valid.json as { output: { type: unknown } }).output.type,
        },
        output_data: "0xdeadbeef",
        block_number: "0x1",
      },
      {
        out_point: { tx_hash: fillHex(0xe2, 32), index: "0x0" },
        output: {
          capacity: "0x100",
          lock: { code_hash: fillHex(0x77, 32), hash_type: "type", args: "0x" },
          type: (valid.json as { output: { type: unknown } }).output.type,
        },
        output_data: "0x",
        block_number: "0x1",
      },
      {
        out_point: { tx_hash: fillHex(0xe3, 32), index: "0x0" },
        output: {
          capacity: "0x100",
          lock: { code_hash: fillHex(0x77, 32), hash_type: "type", args: "0x" },
          type: (valid.json as { output: { type: unknown } }).output.type,
        },
        output_data: "0x" + "ff".repeat(1000),
        block_number: "0x1",
      },
    ];
    const stack = await makeStack({ cells: [...spamCells, valid.json] });
    try {
      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");
      // Only the valid message landed; spam dropped without stalling.
      const stored = await stack.messages.listByState(["received"]);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.body).toBe("real message in spam flood");
      expect(stack.notifier.posted).toHaveLength(1);
      // No leak of the decrypted body into the notification even though it
      // is available at this point in the pipeline.
      expect(stack.notifier.posted[0]!.body).not.toContain("real message in spam flood");
      expect(stack.notifier.posted[0]!.body).toBe("New message. Unlock to view.");
      const epoch = currentRoutingEpoch();
      // No cursor is persisted (see the sorts-BEFORE test); spam simply does not
      // stall the scan.
      expect(
        await stack.cursors.get(
          `incoming-discovery:${epoch.toString()}:${bytesToHex(BOB_PROFILE_ID)}`,
        ),
      ).toBeNull();
    } finally {
      await stack.db.close();
    }
  });

  it("replayed message (same envelope, NEW outpoint) dedups to one chat row", async () => {
    const first = discoveryCellJson("replay me", new Uint8Array(16).fill(0x42));
    // The same envelope replayed from a different outpoint (re-broadcast or a
    // duplicate indexer view) — the envelope message id collapses it.
    const replay = structuredClone(first) as { json: { out_point: { tx_hash: string } } };
    replay.json.out_point.tx_hash = fillHex(0xd9, 32);
    const stack = await makeStack({ cells: [first.json, replay.json] });
    try {
      await stack.engine.runWorker("incoming-discovery");
      expect(await stack.messages.listByState(["received"])).toHaveLength(1);
      expect(stack.notifier.posted).toHaveLength(1);
      expect(stack.notifier.posted[0]!.body).not.toContain("replay me");
      expect(stack.notifier.posted[0]!.body).toBe("New message. Unlock to view.");
    } finally {
      await stack.db.close();
    }
  });

  it("a blocked sender's cells are dropped at ingestion (history preserved)", async () => {
    const stack = await makeStack();
    const sender = await stack.contacts.create({
      displayName: "spammer",
      profileIdHex: "aa".repeat(32),
    });
    await stack.contacts.setBlocked(sender.id, true);
    await stack.db.close();
    const withCell = await makeStack({ cells: [discoveryCellJson("blocked spam").json] });
    try {
      // Re-create the block in the SAME db as the discovery run.
      const blocked = await withCell.contacts.create({
        displayName: "spammer",
        profileIdHex: "aa".repeat(32),
      });
      await withCell.contacts.setBlocked(blocked.id, true);
      await withCell.engine.runWorker("incoming-discovery");
      expect(await withCell.messages.listByState(["received"])).toHaveLength(0);
      expect(withCell.notifier.posted).toHaveLength(0);
      // History: the contact row itself is untouched.
      expect((await withCell.contacts.getById(blocked.id))?.displayName).toBe("spammer");
    } finally {
      await withCell.db.close();
    }
  });

  it("incoming rate limit drops over-limit messages without stalling the scan", async () => {
    const stack = await makeStack();
    try {
      // Drain the per-contact bucket for alice (60/hour default).
      for (let i = 0; i < 60; i++) {
        await stack.deps.rateLimiter.consume("incoming", "aa".repeat(32));
      }
      await stack.db.close();
      const withCell = await makeStack({ cells: [discoveryCellJson("over the limit").json] });
      for (let i = 0; i < 60; i++) {
        await withCell.deps.rateLimiter.consume("incoming", "aa".repeat(32));
      }
      await withCell.engine.runWorker("incoming-discovery");
      expect(await withCell.messages.listByState(["received"])).toHaveLength(0);
      expect(withCell.notifier.posted).toHaveLength(0);
      const epoch = currentRoutingEpoch();
      // No cursor is persisted (see the sorts-BEFORE test); an over-limit cell
      // is skipped without stalling the scan.
      expect(
        await withCell.cursors.get(
          `incoming-discovery:${epoch.toString()}:${bytesToHex(BOB_PROFILE_ID)}`,
        ),
      ).toBeNull();
    } finally {
      await stack.db.close();
    }
  });
});

/**
 * Regression coverage for the auto-lock strand (final review fix 1b).
 *
 * `processDiscoveredCell` advances a newly discovered message through THREE
 * SEPARATE transactions (discovered → downloading → decrypting → received)
 * before it notifies and queues the auto-ack. If the database goes away
 * between them — the observed auto-lock case — the row is left at
 * `downloading` or `decrypting`, and that used to be PERMANENT: `insert()` is
 * ON CONFLICT DO NOTHING + re-read, so a later discovery pass sees the
 * EXISTING row's state, the `=== "discovered"` guard fails, and the whole
 * advance/notify/ack block is skipped. The message is never shown and never
 * acked — so the SENDER also hangs at "sent" forever.
 *
 * Two independent recoveries are covered here: re-discovery of the same cell
 * must re-drive the row, and the pending-transactions healer must re-drive it
 * even if the cell is never seen again (process death after the strand).
 */
describe("stranded incoming messages are healed (final review fix 1b)", () => {
  /** Leave a row exactly where an interrupted processDiscoveredCell would. */
  async function strandIncoming(
    stack: Stack,
    messageId: Uint8Array,
    at: "downloading" | "decrypting",
    body = "stranded hello",
  ): Promise<number> {
    // Derive a distinct contact per messageId so a test can strand several
    // rows in one stack without colliding on the UNIQUE profile_id_hex.
    const contact = await stack.contacts.create({
      displayName: "unknown-stranded",
      profileIdHex: bytesToHex(new Uint8Array([...messageId, ...messageId])),
    });
    const conversation = await stack.conversations.getOrCreateForContact(contact.id);
    const row = await stack.messages.insert({
      conversationId: conversation.id,
      direction: "incoming",
      body,
      logicalMessageId: incomingLogicalMessageId(messageId),
    });
    await stack.messages.setEnvelopeMessageId(row.id, bytesToHex(messageId));
    await stack.messages.setChainRef(row.id, {
      txHash: fillHex(0xd1, 32),
      outpointIndex: 0,
    });
    await stack.messages.transitionState(row.id, "downloading");
    if (at === "decrypting") {
      await stack.messages.transitionState(row.id, "decrypting");
    }
    return row.id;
  }

  for (const at of ["downloading", "decrypting"] as const) {
    it(`heals a row stranded at ${at} via the pending-transactions worker, then notifies and acks`, async () => {
      const stack = await makeStack({ cells: [] });
      try {
        const messageId = hexToBytes("ab".repeat(16));
        const id = await strandIncoming(stack, messageId, at);
        expect((await stack.messages.getById(id))?.state).toBe(at);

        expect(await stack.engine.runWorker("pending-transactions")).toBe("success");

        // Re-driven to received through the normal path — NOT forced to a
        // terminal state.
        expect((await stack.messages.getById(id))?.state).toBe("received");

        // Notified (generic copy only — no sender identity, no content).
        expect(stack.notifier.posted).toHaveLength(1);
        expect(stack.notifier.posted[0]!.title).toBe("CellSend");
        expect(stack.notifier.posted[0]!.body).toBe("New message. Unlock to view.");
        expect(stack.notifier.posted[0]!.body).not.toContain("stranded hello");

        // Auto-acked, so the SENDER can advance past "sent".
        const ack = await stack.messages.getByLogicalId(
          `response:${incomingLogicalMessageId(messageId)}`,
        );
        expect(ack).toBeDefined();
        expect(ack?.direction).toBe("outgoing");
        expect(ack?.state).toBe("queued");
        const ackRef = await stack.messages.getChainRef(ack!.id);
        expect(ackRef?.replyToTxHash).toBe(fillHex(0xd1, 32));
        expect(ackRef?.replyToOutpointIndex).toBe(0);

        // Idempotent: a second heal pass must not re-notify or double-ack.
        expect(await stack.engine.runWorker("pending-transactions")).toBe("success");
        expect(stack.notifier.posted).toHaveLength(1);
        expect(await stack.messages.listByState(["queued"])).toHaveLength(1);
      } finally {
        await stack.db.close();
      }
    });
  }

  it("re-drives a row stranded at downloading when the same cell is discovered again", async () => {
    // The exact reported failure: the cell is still on chain, discovery finds
    // it again, and the existing row is at `downloading` rather than
    // `discovered`. It must be advanced, notified and acked — not skipped.
    const messageId = hexToBytes("cd".repeat(16));
    const { json } = discoveryCellJson("re-discovered hello", messageId);
    const stack = await makeStack({ cells: [json] });
    try {
      const id = await strandIncoming(stack, messageId, "downloading", "re-discovered hello");
      expect((await stack.messages.getById(id))?.state).toBe("downloading");

      expect(await stack.engine.runWorker("incoming-discovery")).toBe("success");

      expect((await stack.messages.getById(id))?.state).toBe("received");
      expect(stack.notifier.posted).toHaveLength(1);
      expect(
        await stack.messages.getByLogicalId(`response:${incomingLogicalMessageId(messageId)}`),
      ).toBeDefined();
    } finally {
      await stack.db.close();
    }
  });

  it("heals later stranded rows even when an earlier row throws mid-advance", async () => {
    // Per-row isolation (discovery already has it; the receive-side healer must
    // too): one row that throws while being re-driven must not strand every
    // row queued behind it. `listByState` is ORDER BY id, so the row stranded
    // first is processed first — make ONLY that one fail and assert the later
    // row still reaches `received` and gets acked.
    const stack = await makeStack({ cells: [] });
    try {
      const idA = hexToBytes("a1".repeat(16));
      const idB = hexToBytes("b2".repeat(16));
      const rowA = await strandIncoming(stack, idA, "downloading", "row A");
      const rowB = await strandIncoming(stack, idB, "downloading", "row B");
      expect(rowA).toBeLessThan(rowB); // A is processed first

      // Fail row A at the notification post — a faithful transient platform
      // error — while every other post still records.
      const recorder = stack.notifier;
      const throwingNotifier: Notifier = {
        post: (content) =>
          content.id === `message:${String(rowA)}`
            ? Promise.reject(new Error("notifier boom (row A)"))
            : recorder.post(content),
        cancel: (_id) => recorder.cancel(),
      };
      (stack.deps as { notifier: Notifier }).notifier = throwingNotifier;

      // One bad row does not crash the worker...
      expect(await stack.engine.runWorker("pending-transactions")).toBe("success");

      // ...and row B is fully healed despite row A throwing first.
      expect((await stack.messages.getById(rowB))?.state).toBe("received");
      expect(
        await stack.messages.getByLogicalId(`response:${incomingLogicalMessageId(idB)}`),
      ).toBeDefined();
    } finally {
      await stack.db.close();
    }
  });
});
