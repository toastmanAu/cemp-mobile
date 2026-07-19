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
  type RateLimiter,
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
  /** Incoming/outgoing rate limits (Phase 11 task 9). */
  readonly rateLimiter: RateLimiter;
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
  // The cursor is keyed by epoch AND profile id: a scan run before the
  // profile existed (or before a rotation) must not advance the position a
  // later same-epoch scan for the real profile resumes from — indexer
  // cursors are global ordering positions, so a cross-profile resume would
  // silently skip cells (found via on-device P2P testing).
  const ownProfileIdHex = bytesToHex(deps.ownProfileId);
  // Watch the current and previous epoch's route tags (protocol §2 grace).
  for (const tagEpoch of [epoch, epoch - 1n]) {
    const routeTag = deriveRouteTag(deps.ownProfileId, tagEpoch);
    const cursorName = `incoming-discovery:${tagEpoch.toString()}:${ownProfileIdHex}`;
    let cursor = (await deps.cursors.get(cursorName)) ?? undefined;
    // A persisted terminal cursor ("0x" from an exhausted scan) must be treated
    // as "start fresh": reusing it as `after` makes the indexer return nothing
    // forever. This also heals cursors already poisoned on-device by the earlier
    // persist-on-empty bug.
    if (cursor === "0x" || cursor === "") {
      cursor = undefined;
    }
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
      if (page.cells.length === 0) {
        // Reached the end of the scan. Do NOT persist the cursor here: an
        // exhausted scan returns a terminal/empty ("0x") cursor, and reusing
        // that as `after` makes the indexer return nothing even once new cells
        // arrive — permanently poisoning discovery. Only positions from a
        // non-empty page are safe to resume from (found via on-device P2P
        // testing; the first pre-message sync was silently poisoning the rest).
        break;
      }
      cursor = page.lastCursor;
      await deps.cursors.set(cursorName, cursor);
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
  // Phase 11 task 10: a blocked sender is dropped at ingestion — history is
  // untouched, nothing new is stored (rule 8 applies to history, not spam).
  if (await deps.contacts.isBlockedByProfileId(senderProfileIdHex)) {
    return;
  }
  // A pure acknowledgement (empty body + receipts) advances OUR outgoing
  // messages but is never shown and is never itself acked — that terminates the
  // exchange (acks carry no content, and only content messages are auto-acked).
  // Not rate-limited: an ack per delivered message is legitimate, not spam.
  if (incoming.text.length === 0 && incoming.receipts.length > 0) {
    await deps.lifecycle.processAcknowledgements(incoming);
    return;
  }
  // Phase 11 task 9: per-contact + global incoming rate limit. Over-limit
  // cells are skipped (the cursor still advances — spam cannot stall sync).
  if (!(await deps.rateLimiter.consume("incoming", senderProfileIdHex))) {
    return;
  }
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
  // Idempotent insert collapses duplicates: an already-received row needs no
  // transition, but its receipts are processed EVERY time (review E8 — a
  // swallowed ack must not strand the sender's capacity).
  if (inserted.state === "discovered") {
    await deps.messages.setEnvelopeMessageId(inserted.id, bytesToHex(incoming.messageId));
    await deps.messages.transitionState(inserted.id, "downloading");
    await deps.messages.transitionState(inserted.id, "decrypting");
    await deps.messages.transitionState(inserted.id, "received");
    // Notification (task 8): messages channel, contact name + preview.
    await deps.notifier.post({
      id: `message:${String(inserted.id)}`,
      channel: "messages",
      title: contact.displayName,
      body: incoming.text.length > 60 ? `${incoming.text.slice(0, 57)}…` : incoming.text,
    });
    // Auto-ack on receive (§7.3, ADR 0005): queue a receipt-only response so the
    // sender advances to delivered/read without any action here. Idempotent on
    // the `response:` logical id; the response-sender worker publishes it.
    await queueAcknowledgement(deps, {
      conversationId: conversation.id,
      originalLogicalId: inserted.logicalMessageId,
      originalCell: { txHash, outpointIndex },
    });
  }
  // A reply that ALSO carries receipts (content + ack) still advances OUR
  // outgoing messages — processAcknowledgements is idempotent.
  if (incoming.receipts.length > 0) {
    await deps.lifecycle.processAcknowledgements(incoming);
  }
}

/**
 * Queue a receipt-only acknowledgement response for a freshly received message
 * (ADR 0005). The response is a normal OUTGOING `queued` row whose logical id is
 * prefixed `response:` and whose chain ref names the original cell; the
 * response-sender worker publishes it with a 0x01 receipt. Idempotent: a second
 * discovery of the same message finds the existing row and does nothing.
 */
async function queueAcknowledgement(
  deps: SyncWorkerDeps,
  input: {
    conversationId: number;
    originalLogicalId: string;
    originalCell: { txHash: string; outpointIndex: number };
  },
): Promise<void> {
  const responseLogicalId = `response:${input.originalLogicalId}`;
  if ((await deps.messages.getByLogicalId(responseLogicalId)) !== undefined) {
    return;
  }
  const row = await deps.messages.insert({
    conversationId: input.conversationId,
    direction: "outgoing",
    body: "",
    logicalMessageId: responseLogicalId,
    state: "queued",
  });
  await deps.messages.setChainRef(row.id, {
    replyToTxHash: input.originalCell.txHash,
    replyToOutpointIndex: input.originalCell.outpointIndex,
  });
}

/* ── response sender (§12 worker 6) ──────────────────────────────────────── */

/**
 * Drain queued acknowledgement responses (ADR 0005). A response is a normal
 * OUTGOING `queued` row whose logical id is `response:<originalIncomingLogicalId>`
 * with the original cell's outpoint in its chain ref (reply_to fields). Each is
 * published with the receipt for the original via the standard outgoing path,
 * then the original's watch is registered (Phase 8 task 9). The UNIQUE logical
 * id makes duplicate worker runs converge on one response (exit criterion 3).
 */
async function runResponseSender(deps: SyncWorkerDeps): Promise<void> {
  const queued = (await deps.messages.listByState(["queued"])).filter(
    (m) => m.direction === "outgoing" && m.logicalMessageId.startsWith("response:"),
  );
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
      if (tx.purpose.startsWith("reclaim:")) {
        // Review E6: do NOT pre-mark reclaim txs — the lifecycle resume path
        // requires `submitted` and owns finalization (CAS + fee-net release).
        await deps.lifecycle.executeReclaimBatch();
        continue;
      }
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
      }
    } else if (status.status === "rejected") {
      await deps.outgoingTxs.markState(tx.txHash, "rejected");
    }
  }

  // Heal messages stranded behind an already-committed tx. The publish monitor
  // marks the outgoing tx `committed` BEFORE advancing the message, so an
  // interruption (background/lock/kill) between those two writes leaves the
  // message at pending/committed with a committed tx — which the `submitted`
  // scan above never revisits. Bring it forward so it becomes ack-able (found
  // live: a message stuck at "sent" could never advance to delivered/read).
  const stranded = await deps.messages.listByState(["pending", "committed"]);
  for (const message of stranded) {
    const journal = await deps.outgoingTxs.findLatestByPurpose(
      `message:${message.logicalMessageId}`,
    );
    if (journal?.state !== "committed") {
      continue;
    }
    if (message.state === "pending") {
      await deps.messages.transitionState(message.id, "committed");
    }
    await deps.messages.transitionState(message.id, "available_on_chain");
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
