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
  type OutPoint,
  type RateLimiter,
} from "@cemp/ckb";
import { codec, deriveRouteTag } from "@cemp/core";
import { checkManifest } from "@cemp/images";
import type {
  AttachmentRepository,
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
  // Strict: chain/RPC hex is hostile input (rule 4) — reject odd lengths and
  // non-hex outright rather than coercing garbage to zero bytes.
  if (bare.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(bare)) {
    throw new Error(`workers: invalid hex string of length ${bare.length}`);
  }
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
  readonly attachments: AttachmentRepository;
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
  /**
   * Resolves this device's own 32-byte profile id, called fresh once per
   * worker tick — never cached here or by the caller. A profile published
   * earlier in the SAME session (first-run: publish, then the very next
   * incoming-discovery tick) must be scanned for immediately; a
   * construction-time snapshot cannot express that (that snapshot is the
   * sender-id device bug's incoming half — see the fix report). Resolves to
   * `undefined` when no profile has been published yet: there is no route
   * tag to scan and no key to decrypt with, and that is a legitimate,
   * expected state for a background worker to find, not an error.
   */
  readonly ownProfileId: () => Promise<Uint8Array | undefined>;
  readonly ownKemSecretKey: Uint8Array;
  /**
   * Reclaim one attachment group on-chain (spec §9.5). Injected by the
   * composition root as a closure over signer/client/journal that runs the
   * real `reclaimAttachmentGroup` (the worker package holds no signer): the
   * worker owns the scan + skip logic; this owns the chain work.
   */
  readonly reclaimAttachmentGroup: (input: {
    reclaimGroupId: Uint8Array;
    outpoints: readonly OutPoint[];
  }) => Promise<unknown>;
}

function spec(id: WorkerId, requiresNetwork: boolean, run: () => Promise<void>): WorkerSpec {
  return { id, intervalMs: WORKER_INTERVALS[id], requiresNetwork, run };
}

/** All §12 workers, wired to the pipelines. */
export function buildWorkerSpecs(deps: SyncWorkerDeps): WorkerSpec[] {
  return [
    // ORDER MATTERS (runAllNow drains in registration order): pending
    // transactions run FIRST so our own committed messages reach
    // `available_on_chain` before incoming receipts are applied to them in the
    // same pass. Discovery consumes an ack cell exactly once — the cursor moves
    // past it — so a receipt skipped because its message was not yet ack-able
    // is lost forever (the message could never reach delivered/read).
    // Discovery then precedes response-sender so auto-acks queued this pass are
    // published in the same pass.
    spec("pending-transactions", true, () => runPendingTransactions(deps)),
    spec("incoming-discovery", true, () => runIncomingDiscovery(deps)),
    spec("response-sender", true, () => runResponseSender(deps)),
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
  // Resolved ONCE per tick (not per cell/route tag): the route-tag loop
  // below and `processDiscoveredCell` must agree on the same value within a
  // run, and a per-cell repository lookup would be needless DB traffic.
  // `undefined` means no profile has been published yet — there is no
  // inbox to scan, so do nothing and return cleanly. Scanning a route tag
  // derived from a fabricated zero id was the incoming half of the
  // sender-id device bug: it scans a tag nobody addresses, silently
  // discovering nothing for the rest of the session.
  const ownProfileId = await deps.ownProfileId();
  if (ownProfileId === undefined) {
    return;
  }
  const now = Date.now();
  const epoch = currentRoutingEpoch(now);
  // NO cursor is persisted between runs. A message cell's type args are
  // `version ‖ routeTag ‖ conversationTag ‖ messageNonce`, and the indexer
  // orders a prefix search BY THOSE ARGS — which end in a RANDOM 32-byte nonce.
  // A newly published cell therefore sorts arbitrarily within the tag, very
  // often BEFORE a cursor stored by an earlier scan, and `after: <cursor>` skips
  // it forever (verified live: a committed cell at the right route tag was never
  // discovered, while a cursorless scan always returned it). The result set per
  // route tag is bounded — one epoch of one conversation — so each run re-scans
  // it and the idempotent insert (logical message id) collapses the repeats.
  // The cursor below paginates WITHIN a single scan only.
  // Watch the current and previous epoch's route tags (protocol §2 grace).
  for (const tagEpoch of [epoch, epoch - 1n]) {
    const routeTag = deriveRouteTag(ownProfileId, tagEpoch);
    let cursor: string | undefined = undefined;
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
            ownProfileId,
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
      // An exhausted scan returns a terminal ("0x") cursor; paging on it would
      // yield nothing forever, so stop as soon as a page comes back empty.
      if (page.cells.length === 0 || page.lastCursor === "0x" || page.lastCursor === "") {
        break;
      }
      cursor = page.lastCursor;
    }
  }
}

async function processDiscoveredCell(
  deps: SyncWorkerDeps,
  ownProfileId: Uint8Array,
  cellDataHex: string,
  txHash: string,
  outpointIndex: number,
): Promise<void> {
  const cellData = hexToBytes(cellDataHex);
  const incoming = processIncomingText({
    cellData,
    ownKemSecretKey: deps.ownKemSecretKey,
    ownProfileId,
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
  // Image branch (design §3 step 1): an attachment message stores its manifest
  // (thumbnail embedded) so the bubble renders immediately with no fetch. The
  // full-res chunk download is deferred to a user tap (downloadAttachment).
  //
  // The envelope-derived attachment key is persisted WITH the manifest row
  // (schema v8; rule 3 — the database is encrypted). Re-deriving it at tap
  // time from the message cell depended on that cell still being live, which
  // the SENDER controls (rule 9 reclaim after ack) — a reclaimed cell
  // permanently bricked tap-to-download even though the row survived
  // (rule 8). The in-memory copy is wiped right after it is stored.
  //
  // Discovery persists no cursor (see the comment in runIncomingDiscovery), so
  // the same cell is re-scanned on every worker tick, and a healed/stranded
  // row can also re-enter this function — guard on existing rows (the same
  // check-before-create idempotency pattern queueAcknowledgement uses) so a
  // manifest is persisted exactly once per message.
  if (incoming.attachmentManifests.length > 0) {
    if ((await deps.attachments.listForMessage(inserted.id)).length === 0) {
      for (const manifest of incoming.attachmentManifests) {
        // Rule 4 receive-side hardening: the manifest is validated BEFORE it is
        // persisted (the same checkManifest the download path runs). A hostile
        // manifest — decompression-bomb sizes, a chunk count that doesn't match
        // the declared ciphertext — never reaches the attachments table: the
        // message stays a plain row and the worker carries on.
        if (!checkManifest(manifest).ok) {
          continue;
        }
        await deps.attachments.create({
          messageId: inserted.id,
          kind: "image",
          byteLength: Number(manifest.plaintext_size),
          manifest: codec.encodeAttachmentManifestV1(manifest),
          attachmentKey: incoming.attachmentKey,
        });
      }
    }
    // The key now lives in the encrypted database (or the row was already
    // persisted on an earlier scan); drop the in-memory copy either way
    // (processAcknowledgements below only reads `incoming.receipts`).
    incoming.attachmentKey.fill(0);
  }
  // Idempotent insert collapses duplicates: an already-received row needs no
  // transition, but its receipts are processed EVERY time (review E8 — a
  // swallowed ack must not strand the sender's capacity).
  //
  // The guard admits the two MID-ADVANCE states as well as `discovered`. The
  // advance below spans three separate transactions, so an interruption
  // (auto-lock closing the database, process death) can leave the row at
  // `downloading`/`decrypting`; because `insert()` is ON CONFLICT DO NOTHING
  // + re-read, a later pass sees that state, and a `=== "discovered"` guard
  // would skip the block FOREVER — never notified, never acked, with the
  // sender hung at "sent". `advanceIncomingToReceived` walks from wherever
  // the row actually is.
  if (STRANDABLE_INCOMING_STATES.has(inserted.state)) {
    await deps.messages.setEnvelopeMessageId(inserted.id, bytesToHex(incoming.messageId));
    // Record the source cell BEFORE the advance: the healer (runPendingTransactions)
    // rebuilds the auto-ack from this chain ref when the cell itself is never
    // discovered again.
    await deps.messages.setChainRef(inserted.id, { txHash, outpointIndex });
    await advanceIncomingToReceived(deps, inserted.id, inserted.state, {
      conversationId: conversation.id,
      logicalMessageId: inserted.logicalMessageId,
      cell: { txHash, outpointIndex },
    });
  }
  // A reply that ALSO carries receipts (content + ack) still advances OUR
  // outgoing messages — processAcknowledgements is idempotent.
  if (incoming.receipts.length > 0) {
    await deps.lifecycle.processAcknowledgements(incoming);
  }
}

/**
 * Incoming states from which the advance-to-`received` path can still be
 * driven: the initial state plus the two the multi-transaction advance can be
 * interrupted in. See the guard in {@link processDiscoveredCell}.
 */
const STRANDABLE_INCOMING_STATES: ReadonlySet<string> = new Set([
  "discovered",
  "downloading",
  "decrypting",
]);

/** The incoming advance path, in order (§11 state machine). */
const INCOMING_ADVANCE_ORDER = ["discovered", "downloading", "decrypting", "received"] as const;

/**
 * Drive an incoming message from wherever it currently sits up to `received`,
 * then notify and queue the auto-ack.
 *
 * Shared by first discovery and by the stranded-message healer so both take
 * the SAME path: only the transitions still outstanding are applied (the §11
 * machine is strict and forward-only, so replaying an already-applied one
 * would throw). Notify and ack run once the row is at `received`; both are
 * idempotent on the row id / `response:` logical id, so healing a row that
 * was already notified cannot double-notify or double-ack.
 */
async function advanceIncomingToReceived(
  deps: SyncWorkerDeps,
  messageId: number,
  fromState: string,
  context: {
    conversationId: number;
    logicalMessageId: string;
    /**
     * The message's source outpoint, which the auto-ack must name. Absent only
     * when healing a row whose chain ref was never written (an interruption
     * before that write): the message is still advanced and shown, but no
     * unaddressed ack is queued.
     */
    cell?: { txHash: string; outpointIndex: number };
  },
): Promise<void> {
  const startIndex = INCOMING_ADVANCE_ORDER.indexOf(
    fromState as (typeof INCOMING_ADVANCE_ORDER)[number],
  );
  if (startIndex < 0) {
    return; // already past `received` (or invalid) — nothing to drive
  }
  for (const next of INCOMING_ADVANCE_ORDER.slice(startIndex + 1)) {
    await deps.messages.transitionState(messageId, next);
  }
  // Notification (task 8; hardened per security review — no sender identity
  // or message content ever leaves the app, regardless of the device's
  // "hide sensitive content" setting, which the app cannot verify or trust
  // as a default). Copy matches the locked-probe notification in
  // background-sync-core.ts: generic, always — detail is shown only in-app
  // after unlock.
  await deps.notifier.post({
    id: `message:${String(messageId)}`,
    channel: "messages",
    title: "CellSend",
    body: "New message. Unlock to view.",
  });
  // Auto-ack on receive (§7.3, ADR 0005): queue a receipt-only response so the
  // sender advances to delivered/read without any action here. Idempotent on
  // the `response:` logical id; the response-sender worker publishes it.
  if (context.cell !== undefined) {
    await queueAcknowledgement(deps, {
      conversationId: context.conversationId,
      originalLogicalId: context.logicalMessageId,
      originalCell: context.cell,
    });
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
          // Review M-2: the publish monitor that would have reserved the
          // cell's capacity never ran — reserve now, or the later ack's
          // markCapacityReclaimable fires against an unfunded bucket.
          await deps.lifecycle.reserveCommittedCapacity(message.id);
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
    // Review M-2: same reserve gap as the `submitted` scan above — the
    // monitor was interrupted before it could reserve the cell's capacity.
    await deps.lifecycle.reserveCommittedCapacity(message.id);
  }

  await healStrandedIncoming(deps);
}

/**
 * Heal INCOMING messages stranded mid-advance at `downloading`/`decrypting`.
 *
 * The counterpart of the outgoing heal above, for the receive side. Discovery
 * advances a new message through three separate transactions before notifying
 * and acking; an auto-lock closing the database (or process death) between
 * them leaves the row part-way. Serializing `close()` behind the transaction
 * mutex closes the auto-lock window, but NOT process death — so the row still
 * has to be recoverable after the fact, and re-discovery alone cannot be
 * relied on (the cell may be reclaimed, or the scan may never see it again).
 *
 * Rows are re-driven through the NORMAL path (`advanceIncomingToReceived`),
 * never forced to a terminal state: the message is intact, only its bookkeeping
 * was interrupted. Healing makes it visible AND acked, which is what releases
 * the sender from "sent".
 */
async function healStrandedIncoming(deps: SyncWorkerDeps): Promise<void> {
  // `downloading`/`decrypting` are incoming-only states (§11), but filter on
  // direction anyway rather than trusting that invariant from here.
  const stranded = (await deps.messages.listByState(["downloading", "decrypting"])).filter(
    (message) => message.direction === "incoming",
  );
  for (const message of stranded) {
    try {
      // The source cell is recorded before the advance begins, so the auto-ack
      // can name the original outpoint. Without it the ack has nothing to
      // reference — advance and notify anyway (the user still sees the message),
      // but skip the ack rather than queue an unaddressed one.
      const ref = await deps.messages.getChainRef(message.id);
      const cell =
        ref?.txHash != null && ref.outpointIndex !== null
          ? { txHash: ref.txHash, outpointIndex: ref.outpointIndex }
          : undefined;
      await advanceIncomingToReceived(deps, message.id, message.state, {
        conversationId: message.conversationId,
        logicalMessageId: message.logicalMessageId,
        ...(cell === undefined ? {} : { cell }),
      });
    } catch {
      // One row that fails to re-drive (a transient DB/notifier error) must not
      // strand every row queued behind it — the same per-item isolation the
      // discovery loop uses. The row stays at its interrupted state and is
      // retried on the next tick.
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
    await reclaimAttachmentGroups(deps);
  } finally {
    await deps.leases.release("reclaim:batch", deps.engineId);
  }
}

/**
 * Attachment group reclaim (spec §9.5; T17 finding F-2): the batch reclaim
 * above only spends the MESSAGE cell — without this pass the chunk cells stay
 * locked forever. For every outgoing `reclaimed` row with an attachment
 * manifest, reclaim its chunk cells through the (injected) journaled group
 * path. Idempotent: a committed `reclaim-attachment:<groupId>` journal entry
 * suppresses re-attempts, and the group call itself resumes a submitted one
 * or no-ops when every cell is already spent. Per-group failures are isolated
 * (the healStrandedIncoming precedent) and retried on the next pass.
 */
async function reclaimAttachmentGroups(deps: SyncWorkerDeps): Promise<void> {
  const reclaimed = (await deps.messages.listByState(["reclaimed"])).filter(
    (message) => message.direction === "outgoing",
  );
  for (const message of reclaimed) {
    try {
      const withManifest = (await deps.attachments.listForMessage(message.id)).find(
        (a) => a.manifest !== null,
      );
      if (withManifest?.manifest == null) {
        continue;
      }
      const manifest = codec.decodeAttachmentManifestV1(withManifest.manifest);
      const purpose = `reclaim-attachment:${bytesToHex(manifest.reclaim_group_id)}`;
      const journaled = await deps.outgoingTxs.findLatestByPurposePrefix(purpose);
      if (journaled !== undefined && journaled.state === "committed") {
        continue;
      }
      // Message cell first (already spent by the batch reclaim — the group
      // call filters non-live cells), then every chunk cell in order.
      const ref = await deps.messages.getChainRef(message.id);
      const outpoints: OutPoint[] = [
        ...(ref?.txHash != null && ref.outpointIndex !== null
          ? [{ txHash: ref.txHash, index: `0x${ref.outpointIndex.toString(16)}` }]
          : []),
        ...manifest.chunk_outpoints.map((o) => ({
          txHash: `0x${bytesToHex(o.tx_hash)}`,
          index: `0x${o.index.toString(16)}`,
        })),
      ];
      await deps.reclaimAttachmentGroup({
        reclaimGroupId: manifest.reclaim_group_id,
        outpoints,
      });
    } catch {
      // One bad group (transient chain/DB error) must not block the rest —
      // the row is retried on the next reclaim pass.
    }
  }
}
