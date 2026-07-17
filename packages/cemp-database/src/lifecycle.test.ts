import { Cell, CellOutput, Script, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET } from "@cemp/core";
import { mldsaV2KeygenFromSeed } from "@cemp/crypto";
import { buildMessageTypeArgs, type CempMessageTypeRef } from "@cemp/ckb";
import { CempClient, type JsonRpcTransport } from "@cemp/ckb";
import type { IncomingTextMessage } from "@cemp/ckb";
import { ResponseLifecycle, parseReclaimPurpose } from "@cemp/ckb";
import { MlDsaV2TxSigner } from "@cemp/ckb";
import { MockCkbClient, fillHex, hashFromRpcBody, toOutputLike } from "@cemp/ckb/testing";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import { migrate } from "./migrate.js";
import { NodeSqliteAdapter } from "./node.js";
import { BalanceRepository } from "./repositories/balances.js";
import { ContactRepository } from "./repositories/contacts.js";
import { ConversationRepository } from "./repositories/conversations.js";
import { MessageRepository } from "./repositories/messages.js";
import { OutgoingTransactionRepository } from "./repositories/outgoing-transactions.js";
import { DatabasePublicationStore } from "./repositories/publication-store.js";
import { WatchedOutpointRepository } from "./repositories/watched-outpoints.js";

/**
 * Phase 8 lifecycle integration (offline): ack processing, batch reclaim with
 * capacity accounting, crash-resume, responder watch + history preservation —
 * against the REAL database adapter and the REAL reclaim builder/signer.
 */

function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const keyPair = mldsaV2KeygenFromSeed(hexToBytes(vectors.keygen[0]!.seed));

const MESSAGE_TYPE_REF: CempMessageTypeRef = {
  codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
  hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
  cellDep: {
    txHash: CKB_TESTNET.deployments.cempMessageType!.txHash,
    index: "0x0",
    depType: "code",
  },
};

// ── chain fixture (mock CCC chain for the signer + fake RPC transport) ────

function makeChain(liveCells: Map<string, Cell>): {
  client: CempClient;
  signer: MlDsaV2TxSigner;
  mockChain: MockCkbClient;
} {
  const transport: JsonRpcTransport = {
    call(_url, method, params) {
      switch (method) {
        case "get_live_cell": {
          const req = params[0] as { tx_hash: string; index: string };
          const key = `${req.tx_hash}:${BigInt(req.index).toString()}`;
          const cell = liveCells.get(key);
          if (cell === undefined) {
            return Promise.resolve({ cell: null, status: "dead" });
          }
          const type = cell.cellOutput.type;
          return Promise.resolve({
            cell: {
              output: {
                capacity: `0x${cell.cellOutput.capacity.toString(16)}`,
                lock: {
                  code_hash: cell.cellOutput.lock.codeHash,
                  hash_type: cell.cellOutput.lock.hashType,
                  args: cell.cellOutput.lock.args,
                },
                type:
                  type === undefined
                    ? null
                    : { code_hash: type.codeHash, hash_type: type.hashType, args: type.args },
              },
              data: { content: cell.outputData, hash: fillHex(0x00, 32) },
            },
            status: "live",
          });
        }
        case "send_transaction":
          return Promise.resolve(hashFromRpcBody(params[0] as Record<string, unknown>));
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
        default:
          return Promise.reject(new Error(`fake chain: unexpected method ${method}`));
      }
    },
  };
  const mockChain = new MockCkbClient();
  const signer = new MlDsaV2TxSigner({ keyPair, client: mockChain });
  return { client: new CempClient({ transport }), signer, mockChain };
}

function outpointKey(txHash: string, index: number): string {
  return `${txHash}:${String(index)}`;
}

function messageCell(ckbAmount: number, seed: number, lock: Script): Cell {
  const typeArgs = buildMessageTypeArgs(
    hexToBytes("aa".repeat(32)),
    hexToBytes("bb".repeat(16)),
    hexToBytes("cc".repeat(16)),
  );
  return Cell.from({
    outPoint: { txHash: fillHex(seed, 32), index: 0 },
    cellOutput: toOutputLike(
      CellOutput.from({
        capacity: fixedPointFrom(ckbAmount),
        lock,
        type: {
          codeHash: MESSAGE_TYPE_REF.codeHash,
          hashType: MESSAGE_TYPE_REF.hashType,
          args: hexFrom(typeArgs),
        },
      }),
    ),
    outputData: "0x1234",
  });
}

function fundingCell(ckbAmount: number, seed: number, lock: Script): Cell {
  return Cell.from({
    outPoint: { txHash: fillHex(seed, 32), index: 1 },
    cellOutput: toOutputLike(CellOutput.from({ capacity: fixedPointFrom(ckbAmount), lock })),
    outputData: "0x",
  });
}

// ── db fixture ─────────────────────────────────────────────────────────────

async function makeDb() {
  const db = new NodeSqliteAdapter();
  await migrate(db);
  const contacts = new ContactRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  const outgoingTxs = new OutgoingTransactionRepository(db);
  const watchedOutpoints = new WatchedOutpointRepository(db);
  const balances = new BalanceRepository(db);
  const walletId = await balances.ensureWallet("main");
  const store = new DatabasePublicationStore(messages, outgoingTxs, {
    watchedOutpoints,
    balances,
    walletId,
  });
  return {
    db,
    contacts,
    conversations,
    messages,
    outgoingTxs,
    watchedOutpoints,
    balances,
    walletId,
    store,
  };
}

async function makeOutgoingConversation(stack: Awaited<ReturnType<typeof makeDb>>) {
  const contact = await stack.contacts.create({ displayName: "bob" });
  const conv = await stack.conversations.getOrCreateForContact(contact.id);
  return conv;
}

const OUTGOING_HAPPY_PATH = [
  "queued",
  "encrypting",
  "building_transaction",
  "awaiting_signature",
  "submitting",
  "pending",
  "committed",
  "available_on_chain",
] as const;

// ── tests ──────────────────────────────────────────────────────────────────

describe("ResponseLifecycle.processAcknowledgements (tasks 4–5)", () => {
  it("advances an acknowledged outgoing message to reclaim_queued; skips unknown ids", async () => {
    const stack = await makeDb();
    try {
      const { client, signer } = makeChain(new Map());
      const lifecycle = new ResponseLifecycle({
        client,
        signer,
        messageType: MESSAGE_TYPE_REF,
        store: stack.store,
      });
      const conv = await makeOutgoingConversation(stack);
      const message = await stack.messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "original",
        logicalMessageId: "lm-ack",
      });
      for (const state of OUTGOING_HAPPY_PATH) {
        await stack.messages.transitionState(message.id, state);
      }
      const envId = hexToBytes("1234567890abcdef1234567890abcdef");
      await stack.messages.setEnvelopeMessageId(message.id, "1234567890abcdef1234567890abcdef");

      const reply: IncomingTextMessage = {
        messageId: hexToBytes("ffffffffffffffffffffffffffffffff"),
        conversationId: hexToBytes("99".repeat(32)),
        senderProfileId: hexToBytes("88".repeat(32)),
        text: "reply with ack",
        replyToMessageId: envId,
        replyToOutpoint: null,
        receipts: [
          { messageId: envId, status: 0x01 },
          { messageId: hexToBytes("00".repeat(16)), status: 0x01 }, // unknown — skipped
          { messageId: envId, status: 0x02 }, // not an ack status — skipped
        ],
        clientTimestamp: 0n,
        senderDeviceId: hexToBytes("77".repeat(16)),
      };
      const acked = await lifecycle.processAcknowledgements(reply);
      expect(acked).toEqual([message.id]);
      expect((await stack.messages.getById(message.id))?.state).toBe("reclaim_queued");
    } finally {
      await stack.db.close();
    }
  });
});

describe("ResponseLifecycle.executeReclaimBatch (tasks 6–8)", () => {
  it("batches, journals, broadcasts and returns capacity to available balance", async () => {
    const stack = await makeDb();
    try {
      const { signer, mockChain } = makeChain(new Map());
      const cell = messageCell(500, 0xc1, signer.lockScript());
      const funds = fundingCell(10_000, 0xf1, signer.lockScript());
      mockChain.addCells(cell, funds);
      const liveCells = new Map([
        [outpointKey(cell.outPoint.txHash, Number(cell.outPoint.index)), cell],
      ]);
      // The lifecycle's client sees the live cell; the signer resolves the
      // same cell through its own mock chain.
      const { client } = makeChain(liveCells);
      const lifecycle = new ResponseLifecycle({
        client,
        signer,
        messageType: MESSAGE_TYPE_REF,
        store: stack.store,
      });

      const conv = await makeOutgoingConversation(stack);
      const message = await stack.messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "to reclaim",
        logicalMessageId: "lm-reclaim",
      });
      for (const state of OUTGOING_HAPPY_PATH) {
        await stack.messages.transitionState(message.id, state);
      }
      await stack.messages.transitionState(message.id, "downloaded_by_recipient");
      await stack.messages.transitionState(message.id, "acknowledged");
      await stack.messages.transitionState(message.id, "reclaim_queued");
      await stack.messages.setChainRef(message.id, {
        txHash: cell.outPoint.txHash,
        outpointIndex: Number(cell.outPoint.index),
      });
      // Sender-side ack watch on the same cell — must be cleaned up by the batch.
      await stack.watchedOutpoints.register({
        txHash: cell.outPoint.txHash,
        outpointIndex: Number(cell.outPoint.index),
        purpose: "message-ack",
      });

      // Capacity accounting: available → reserved → reclaimable.
      const cellShannon = fixedPointFrom(500);
      await stack.balances.setChainBalances(
        stack.walletId,
        fixedPointFrom(10_000),
        fixedPointFrom(10_000),
      );
      await stack.balances.reserveCapacity(stack.walletId, cellShannon);
      await stack.balances.markReclaimable(stack.walletId, cellShannon);
      expect((await stack.balances.getBalance(stack.walletId)).reclaimableShannon).toBe(
        cellShannon,
      );

      const result = await lifecycle.executeReclaimBatch();
      expect(result).not.toBeNull();
      expect(result!.resumed).toBe(false);
      expect(result!.reclaimedRowIds).toEqual([message.id]);
      expect(result!.releasedShannon).toBe(cellShannon.toString());
      expect(parseReclaimPurpose(`reclaim:${String(message.id)}`)).toEqual([message.id]);

      // Message reclaimed; journal committed; capacity back to available.
      expect((await stack.messages.getById(message.id))?.state).toBe("reclaimed");
      const journal = await stack.outgoingTxs.getByTxHash(result!.txHash);
      expect(journal?.state).toBe("committed");
      expect(journal?.capacityShannon).toBe(cellShannon.toString());
      const balance = await stack.balances.getBalance(stack.walletId);
      expect(balance.reclaimableShannon).toBe(0n);
      expect(balance.availableShannon).toBe(fixedPointFrom(10_000));
      // The moot ack-watch was spent by the reclaim tx and pruned.
      expect(await stack.watchedOutpoints.listActive()).toHaveLength(0);
    } finally {
      await stack.db.close();
    }
  });

  it("resumes a journaled reclaim batch after a crash (ids + capacity from the journal)", async () => {
    const stack = await makeDb();
    try {
      const { client, signer } = makeChain(new Map());
      const lifecycle = new ResponseLifecycle({
        client,
        signer,
        messageType: MESSAGE_TYPE_REF,
        store: stack.store,
      });
      const conv = await makeOutgoingConversation(stack);
      const message = await stack.messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "crashed reclaim",
        logicalMessageId: "lm-crash-reclaim",
      });
      for (const state of OUTGOING_HAPPY_PATH) {
        await stack.messages.transitionState(message.id, state);
      }
      await stack.messages.transitionState(message.id, "downloaded_by_recipient");
      await stack.messages.transitionState(message.id, "acknowledged");
      await stack.messages.transitionState(message.id, "reclaim_queued");
      await stack.messages.transitionState(message.id, "reclaim_pending");

      // The crashed process had journaled the batch (rule 6) before dying.
      const crashedTx = fillHex(0xcb, 32);
      await stack.outgoingTxs.record({
        txHash: crashedTx,
        purpose: `reclaim:${String(message.id)}`,
        state: "submitted",
        capacityShannon: "50000000000",
      });
      await stack.balances.setChainBalances(
        stack.walletId,
        fixedPointFrom(10_000),
        fixedPointFrom(10_000),
      );
      await stack.balances.reserveCapacity(stack.walletId, 50_000_000_000n);
      await stack.balances.markReclaimable(stack.walletId, 50_000_000_000n);

      const result = await lifecycle.executeReclaimBatch();
      expect(result!.resumed).toBe(true);
      expect(result!.txHash).toBe(crashedTx);
      expect((await stack.messages.getById(message.id))?.state).toBe("reclaimed");
      expect((await stack.balances.getBalance(stack.walletId)).availableShannon).toBe(
        fixedPointFrom(10_000),
      );
    } finally {
      await stack.db.close();
    }
  });
});

describe("ResponseLifecycle responder watch (tasks 9–12)", () => {
  it("registers the watch, detects the spend, prunes temp data, KEEPS chat history", async () => {
    const stack = await makeDb();
    try {
      const { client, signer } = makeChain(new Map()); // no live cells: the original is spent
      const lifecycle = new ResponseLifecycle({
        client,
        signer,
        messageType: MESSAGE_TYPE_REF,
        store: stack.store,
      });
      const conv = await makeOutgoingConversation(stack);
      const incoming = await stack.messages.insert({
        conversationId: conv.id,
        direction: "incoming",
        body: "decrypted history that must survive",
        logicalMessageId: "incoming:resp",
      });
      for (const state of [
        "downloading",
        "decrypting",
        "received",
        "displayed",
        "response_queued",
        "response_sent",
      ] as const) {
        await stack.messages.transitionState(incoming.id, state);
      }

      const originalOutpoint = { txHash: fillHex(0xd1, 32), index: 0 };
      await lifecycle.finalizeResponseSent({ responseRowId: incoming.id, originalOutpoint });
      expect((await stack.messages.getById(incoming.id))?.state).toBe("awaiting_remote_reclaim");
      expect(await stack.watchedOutpoints.listActive()).toHaveLength(1);

      const spentPurposes = await lifecycle.pollWatchesOnce();
      expect(spentPurposes).toEqual([`response:${String(incoming.id)}`]);
      expect((await stack.messages.getById(incoming.id))?.state).toBe("remote_reclaimed");
      // Task 11: temporary chain data pruned…
      expect(await stack.watchedOutpoints.listActive()).toHaveLength(0);
      // …task 12: decrypted chat history fully intact (rule 8).
      const history = await stack.messages.listByConversation(conv.id);
      expect(history).toHaveLength(1);
      expect(history[0]!.body).toBe("decrypted history that must survive");
    } finally {
      await stack.db.close();
    }
  });
});

describe("BalanceRepository accounting (task 8)", () => {
  it("moves reconcile and refuses to drive a category negative", async () => {
    const stack = await makeDb();
    try {
      await stack.balances.setChainBalances(stack.walletId, 1000n, 1000n);
      await stack.balances.reserveCapacity(stack.walletId, 400n);
      await expect(stack.balances.reserveCapacity(stack.walletId, 700n)).rejects.toMatchObject({
        code: "constraint-violation",
      });
      await stack.balances.markReclaimable(stack.walletId, 400n);
      await stack.balances.releaseReclaimedCapacity(stack.walletId, 400n);
      const balance = await stack.balances.getBalance(stack.walletId);
      expect(balance.availableShannon).toBe(1000n);
      expect(balance.reservedShannon).toBe(0n);
      expect(balance.reclaimableShannon).toBe(0n);
      expect(balance.totalShannon).toBe(1000n);
    } finally {
      await stack.db.close();
    }
  });
});
