/**
 * The §12 background workers (spec Phase 9).
 *
 * Battery-conscious intervals (task 6): everything sits at or above the
 * WorkManager 15-minute floor; user-visible latency comes from the
 * foreground catch-up (engine.runAllNow on app open / reconnect), not from
 * aggressive polling. Reclaim and watches are slow because hours of delay
 * are harmless there; maintenance is daily.
 *
 * Every worker is idempotent (rule 5): discovery dedups on the envelope
 * message id, response publishing on the response logical id, reclaim on the
 * journal, cursors make re-runs incremental. Worker-level concurrency comes
 * from the engine's leases; OUTPOINT-level concurrency (task 9) comes from
 * the discovery worker's per-cell leases.
 */

import {
  ResponseLifecycle,
  balanceCategories,
  currentRoutingEpoch,
  findMessageCells,
  incomingLogicalMessageId,
  processIncomingText,
  type CempClient,
  type CempMessageTypeRef,
  type MessagePublisher,
} from "@cemp/ckb";
import { deriveRouteTag } from "@cemp/core";
import type {
  BalanceRepository,
  ContactRepository,
  ConversationRepository,
  MessageRepository,
  OutgoingTransactionRepository,
  SyncCursorRepository,
  WorkerLeaseRepository,
} from "@cemp/database";
import type { Notifier } from "@cemp/ui";
import type { WorkerSpec } from "./engine.js";

/** Worker ids + intervals (task 6; WorkManager floor is 15 minutes). */
export const WORKER_INTERVALS = {
  "incoming-discovery": 15 * 60_000,
  "response-sender": 15 * 60_000,
  "pending-transactions": 15 * 60_000,
  "watched-outpoints": 30 * 60_000,
  "reclaim-batch": 60 * 60_000,
  "balance-refresh": 30 * 60_000,
  "profile-refresh": 6 * 3_600_000,
  "database-maintenance": 24 * 3_600_000,
} as const;
export type WorkerId = keyof typeof WORKER_INTERVALS;

const OUTPOINT_LEASE_TTL_MS = 10 * 60_000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export interface SyncWorkerDeps {
  readonly client: CempClient;
  readonly messageType: CempMessageTypeRef;
  readonly lifecycle: ResponseLifecycle;
  /** The Phase 7 publisher (composition root wires it with signer + store). */
  readonly publisher: MessagePublisher;
  readonly messages: MessageRepository;
  readonly contacts: ContactRepository;
  readonly conversations: ConversationRepository;
  readonly outgoingTxs: OutgoingTransactionRepository;
  readonly cursors: SyncCursorRepository;
  readonly leases: WorkerLeaseRepository;
  readonly balances: BalanceRepository;
  /** Wallet whose balance row the balance-refresh worker updates. */
  readonly walletId: number;
  /** The wallet lock the balance-refresh worker reports on. */
  readonly walletLock: {
    codeHash: string;
    hashType: "type" | "data" | "data1" | "data2";
    args: string;
  };
  readonly notifier: Notifier;
  readonly engineId: string;
  readonly ownProfileId: Uint8Array;
  readonly ownKemSecretKey: Uint8Array;
}

function spec(id: WorkerId, requiresNetwork: boolean, run: () => Promise<void>): WorkerSpec {
  return { id, intervalMs: WORKER_INTERVALS[id], requiresNetwork, run };
}

/** All §12 workers, wired to the pipelines. */
export function buildWorkerSpecs(deps: SyncWorkerDeps): WorkerSpec[] {
  return [
    spec("incoming-discovery", true, () => runIncomingDiscovery(deps)),
    spec("response-sender", true, () => runResponseSender(deps)),
    spec("pending-transactions", true, () => runPendingTransactions(deps)),
    spec("watched-outpoints", true, () => deps.lifecycle.pollWatchesOnce().then(() => undefined)),
    spec("reclaim-batch", true, () => runReclaimBatch(deps)),
    spec("balance-refresh", true, () => runBalanceRefresh(deps)),
    spec("profile-refresh", true, () => Promise.resolve()),
    spec("database-maintenance", false, async () => {
      await deps.leases.pruneExpired();
    }),
  ];
}

/* ── incoming discovery (§12 worker 2; exit criterion 1) ─────────────────── */

async function runIncomingDiscovery(deps: SyncWorkerDeps): Promise<void> {
  const now = Date.now();
  const epoch = currentRoutingEpoch(now);
  // Watch the current and previous epoch's route tags (protocol §2 grace).
  for (const tagEpoch of [epoch, epoch - 1n]) {
    const routeTag = deriveRouteTag(deps.ownProfileId, tagEpoch);
    const cursorName = `incoming-discovery:${tagEpoch.toString()}`;
    let cursor = (await deps.cursors.get(cursorName)) ?? undefined;
    for (;;) {
      const page = await findMessageCells(deps.client, deps.messageType, routeTag, cursor);
      for (const cell of page.cells) {
        const leaseKey = `outpoint:${cell.outPoint.txHash}:${cell.outPoint.index}`;
        const lease = await deps.leases.acquire(leaseKey, deps.engineId, OUTPOINT_LEASE_TTL_MS);
        if (lease === null) {
          continue; // another engine is processing this cell (task 9)
        }
        try {
          await processDiscoveredCell(
            deps,
            cell.data,
            cell.outPoint.txHash,
            Number(BigInt(cell.outPoint.index)),
          );
        } catch {
          // One bad cell never stalls discovery (rule 4): it is transport noise.
        } finally {
          await deps.leases.release(leaseKey, deps.engineId);
        }
      }
      cursor = page.lastCursor;
      await deps.cursors.set(cursorName, cursor);
      if (page.cells.length === 0) {
        break;
      }
    }
  }
}

async function processDiscoveredCell(
  deps: SyncWorkerDeps,
  cellDataHex: string,
  txHash: string,
  outpointIndex: number,
): Promise<void> {
  const cellData = hexToBytes(cellDataHex);
  const incoming = processIncomingText({
    cellData,
    ownKemSecretKey: deps.ownKemSecretKey,
    ownProfileId: deps.ownProfileId,
  });
  const senderProfileIdHex = bytesToHex(incoming.senderProfileId);
  let contact = await deps.contacts.getByProfileId(senderProfileIdHex);
  if (contact === undefined) {
    // Unknown sender: stub contact (QR/profile flows replace it with a
    // verified one — Phase 5 trust evaluation runs before display).
    contact = await deps.contacts.create({
      displayName: `unknown-${senderProfileIdHex.slice(0, 8)}`,
      profileIdHex: senderProfileIdHex,
    });
  }
  const conversation = await deps.conversations.getOrCreateForContact(contact.id);
  const inserted = await deps.messages.insert({
    conversationId: conversation.id,
    direction: "incoming",
    body: incoming.text,
    logicalMessageId: incomingLogicalMessageId(incoming.messageId),
  });
  // Idempotent insert collapses duplicates: an already-received row is done.
  if (inserted.state === "discovered") {
    await deps.messages.setEnvelopeMessageId(inserted.id, bytesToHex(incoming.messageId));
    await deps.messages.transitionState(inserted.id, "downloading");
    await deps.messages.transitionState(inserted.id, "decrypting");
    await deps.messages.transitionState(inserted.id, "received");
    // Receipts inside this reply advance OUR outgoing messages (Phase 8).
    if (incoming.receipts.length > 0) {
      await deps.lifecycle.processAcknowledgements(incoming);
    }
    // Notification (task 8): messages channel, contact name + preview.
    await deps.notifier.post({
      id: `message:${String(inserted.id)}`,
      channel: "messages",
      title: contact.displayName,
      body: incoming.text.length > 60 ? `${incoming.text.slice(0, 57)}…` : incoming.text,
    });
  }
  void txHash;
  void outpointIndex;
}

/* ── response sender (§12 worker 6) ──────────────────────────────────────── */

/**
 * Drain `response_queued`: the app queues a response as
 * logical id `response:<originalIncomingLogicalId>` with the original
 * cell's outpoint in its chain ref (reply_to fields). Each response is
 * published with the receipt for the original, then the original's watch is
 * registered (Phase 8 task 9). The UNIQUE logical id makes duplicate worker
 * runs converge on one response (exit criterion 3).
 */
async function runResponseSender(deps: SyncWorkerDeps): Promise<void> {
  const queued = await deps.messages.listByState(["response_queued"]);
  for (const response of queued) {
    // The response's chain ref names the ORIGINAL cell (reply_to fields),
    // and its logical id embeds the original incoming message's logical id.
    const chainRef = await deps.messages.getChainRef(response.id);
    if (chainRef?.replyToTxHash == null || chainRef.replyToOutpointIndex === null) {
      continue; // not fully prepared — the app completes the row first
    }
    if (!response.logicalMessageId.startsWith("response:")) {
      continue;
    }
    const original = await deps.messages.getByLogicalId(
      response.logicalMessageId.slice("response:".length),
    );
    if (original?.envelopeMessageIdHex == null) {
      continue;
    }
    const conversation = await deps.conversations.getById(response.conversationId);
    const contact =
      conversation === undefined ? undefined : await deps.contacts.getById(conversation.contactId);
    if (contact?.profileIdHex == null) {
      continue; // no verified recipient profile — the app resolves it first
    }
    const originalEnvelopeMessageId = hexToBytes(original.envelopeMessageIdHex);
    await deps.publisher.publishText({
      messageRowId: response.id,
      logicalMessageId: response.logicalMessageId,
      text: response.body ?? "",
      recipientProfileIdHex: contact.profileIdHex,
      replyTo: {
        messageId: originalEnvelopeMessageId,
        outPoint: { txHash: chainRef.replyToTxHash, index: chainRef.replyToOutpointIndex },
      },
      receipts: [{ messageId: originalEnvelopeMessageId, status: 0x01 }],
    });
    // Advance the ORIGINAL incoming message to response_sent, then register
    // the watch on the original cell (Phase 8 task 9). Idempotent walks.
    for (const state of ["displayed", "response_queued", "response_sent"] as const) {
      const current = await deps.messages.getById(original.id);
      if (current === undefined || current.state === state) {
        continue;
      }
      const order = ["received", "displayed", "response_queued", "response_sent"];
      if (order.indexOf(current.state) < order.indexOf(state)) {
        await deps.messages.transitionState(original.id, state);
      }
    }
    await deps.lifecycle.finalizeResponseSent({
      responseRowId: original.id,
      originalOutpoint: { txHash: chainRef.replyToTxHash, index: chainRef.replyToOutpointIndex },
    });
  }
}

/* ── pending transactions (§12 worker 3) ─────────────────────────────────── */

async function runPendingTransactions(deps: SyncWorkerDeps): Promise<void> {
  const submitted = await deps.outgoingTxs.listByState("submitted");
  for (const tx of submitted) {
    const status = await deps.client.getTransaction(tx.txHash);
    if (status.status === "committed") {
      await deps.outgoingTxs.markState(tx.txHash, "committed", {
        committedAtMs: Date.now(),
        blockHash: status.blockHash,
      });
      if (tx.purpose.startsWith("message:")) {
        const logicalId = tx.purpose.slice("message:".length);
        const message = await deps.messages.getByLogicalId(logicalId);
        if (message?.state === "pending") {
          await deps.messages.transitionState(message.id, "committed");
          await deps.messages.transitionState(message.id, "available_on_chain");
        }
      } else if (tx.purpose.startsWith("reclaim:")) {
        // The lifecycle resume path owns reclaim finalization incl. capacity.
        await deps.lifecycle.executeReclaimBatch();
      }
    } else if (status.status === "rejected") {
      await deps.outgoingTxs.markState(tx.txHash, "rejected");
    }
  }
}

/* ── balance refresh (§12 worker 8; Phase 4 task 7) ──────────────────────── */

/**
 * Chain-derived balance categories (spec §5.5): total + available come from
 * the indexer (available = total minus CEMP protocol cells). The DB's
 * reserved/reclaimable rows are the pipeline's finer-grained view and are
 * NOT overwritten here — the refresh feeds the wallet screen's total and
 * available numbers.
 */
async function runBalanceRefresh(deps: SyncWorkerDeps): Promise<void> {
  const categories = await balanceCategories(deps.client, deps.walletLock, {
    codeHash: deps.messageType.codeHash,
    hashType: deps.messageType.hashType,
  });
  await deps.balances.setChainBalances(
    deps.walletId,
    categories.totalShannon,
    categories.availableShannon,
  );
}

/* ── reclaim batch (§12 worker 7; task 10 lease) ─────────────────────────── */

async function runReclaimBatch(deps: SyncWorkerDeps): Promise<void> {
  const lease = await deps.leases.acquire("reclaim:batch", deps.engineId, OUTPOINT_LEASE_TTL_MS);
  if (lease === null) {
    return; // another engine holds the reclaim job (task 10)
  }
  try {
    await deps.lifecycle.executeReclaimBatch();
  } finally {
    await deps.leases.release("reclaim:batch", deps.engineId);
  }
}
