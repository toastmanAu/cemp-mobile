/**
 * The §12 background workers (spec Phase 9).
 *
 * Battery-conscious intervals (task 6): everything but `lora` sits at or
 * above the WorkManager 15-minute floor; user-visible latency comes from the
 * foreground catch-up (engine.runAllNow on app open / reconnect), not from
 * aggressive polling. Reclaim and watches are slow because hours of delay
 * are harmless there; maintenance is daily. `lora` is a LOCAL gateway poll
 * (docs/lora-transport): below the floor WorkManager clamps it to 15 minutes
 * in the background, and the 30s cadence only takes effect via foreground
 * catch-up — foreground-only for v1 is the deliberate design.
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
  type CempClient,
  type CempMessageTypeRef,
  type MessagePublisher,
  type OutPoint,
  type RateLimiter,
} from "@cemp/ckb";
import { codec, deriveRouteTag } from "@cemp/core";
import { computeReceiptProof } from "@cemp/crypto";
import { LoraTransport, type LoraPollResult } from "@cemp/lora";
import type {
  AttachmentRepository,
  BalanceRepository,
  ContactRepository,
  ConversationRepository,
  IncomingDispositionRepository,
  LocalSettingsRepository,
  MessageRepository,
  OutgoingTransactionRepository,
  SyncCursorRepository,
  WorkerLeaseRepository,
} from "@cemp/database";
import {
  advanceIncomingToReceived,
  ingestIncomingCellData,
  PreDecryptBudget,
  type SenderResolver,
} from "./ingest.js";

export { ingestIncomingCellData } from "./ingest.js";
import type { Notifier } from "@cemp/ui";
import type { WorkerSpec } from "./engine.js";

/** Worker ids + intervals (task 6; WorkManager floor is 15 minutes). */
export const WORKER_INTERVALS = {
  "incoming-discovery": 15 * 60_000,
  lora: 30_000,
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
  /**
   * Resolves and verifies the sender of every v3 message (ADR 0007 §5):
   * `AuthenticatedSenderResolver` over the network client + contacts table.
   */
  readonly senderResolver: SenderResolver;
  /** Per-cell ingested / rejected / deferred-with-backoff (schema v11). */
  readonly dispositions: IncomingDispositionRepository;
  /** Pre-decryption budgets per tick (defaults: PRE_DECRYPT_LIMITS). */
  readonly preDecryptLimits?: { perSync: number; perFundingLock: number };
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
   * Device-scoped settings (the `settings` table). The lora worker reads its
   * toggle + gateway URL here, FRESH on every tick — flipping the setting
   * takes effect on the next tick without rebuilding the engine.
   */
  readonly localSettings: LocalSettingsRepository;
  /**
   * The network config's LoRa gateway default (`network.lora.baseUrl` from
   * @cemp/core — AGENTS.md: endpoints are never hard-coded in feature code).
   * Used only when the user has not set a gateway URL in settings; null on
   * stock builds (off by default).
   */
  readonly loraNetworkBaseUrl?: string | null;
  /**
   * Test seam: overrides `LoraTransport` construction so worker tests inject
   * a fake poll source without HTTP. Production wiring leaves this unset and
   * the worker builds a real `LoraTransport` over the global fetch.
   */
  readonly createLoraTransport?: (config: {
    baseUrl: string;
    routeTags: Uint8Array[];
  }) => LoraPollSource;
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

/** The poll half of `LoraTransport` — the worker's view of a LoRa source. */
export interface LoraPollSource {
  poll(sinceCursor: string | null): Promise<LoraPollResult>;
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
    // LoRa gateway poll (docs/lora-transport): after chain discovery so a
    // chain receipt for a chain message is applied before any LoRa traffic in
    // the same pass. Self-gating: no-ops unless the user enabled the relay.
    spec("lora", true, () => runLoraPoll(deps)),
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
  // One pre-decryption budget for the whole tick (ADR 0007 question 3).
  const budget = new PreDecryptBudget(deps.preDecryptLimits);
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
            budget,
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
  budget: PreDecryptBudget,
): Promise<void> {
  await ingestIncomingCellData(deps, ownProfileId, cellDataHex, { txHash, outpointIndex }, budget);
}

/* ── lora gateway poll (docs/lora-transport Phase L3) ────────────────────── */

/** Settings keys (the `settings` table via LocalSettingsRepository). */
export const LORA_ENABLED_SETTING_KEY = "lora.enabled";
export const LORA_GATEWAY_URL_SETTING_KEY = "lora.gateway_url";
/** Sync-cursor name for the gateway poll position. */
export const LORA_CURSOR_NAME = "lora-transport-cursor";

/**
 * Poll the LoRa gateway for reassembled CEMP envelopes and feed each through
 * the same ingest tail chain discovery uses. Receive-only in v1: ingested
 * messages get no auto-ack (no chain outpoint to address it to).
 *
 * Self-gating (the toggle is read fresh per tick — specs are built once per
 * unlock, so the gate lives in the run closure, not in buildWorkerSpecs):
 * disabled (the default — rule 10: the relay is never a protocol dependency),
 * no gateway URL anywhere, or no published profile all no-op cleanly.
 *
 * Hostile-input discipline is shared: the transport validates shape/crc and
 * runs the codec envelope check; anything that still throws here (an
 * envelope valid in shape but not addressed to us / not decryptable) is
 * isolated per object, exactly like a bad chain cell. A poll-level failure
 * (network, non-200, malformed response) propagates so the engine backs off
 * and retries; the cursor is only persisted after a fully drained poll, so a
 * failed poll never loses objects.
 *
 * The gateway is queried by ROUTE TAG ONLY (plan §5): the profile id never
 * leaves the device.
 */
async function runLoraPoll(deps: SyncWorkerDeps): Promise<void> {
  if ((await deps.localSettings.get(LORA_ENABLED_SETTING_KEY)) !== "true") {
    return;
  }
  const settingsUrl = (await deps.localSettings.get(LORA_GATEWAY_URL_SETTING_KEY))?.trim();
  const baseUrl =
    settingsUrl !== undefined && settingsUrl.length > 0
      ? settingsUrl
      : (deps.loraNetworkBaseUrl ?? null);
  if (baseUrl === null || baseUrl.length === 0) {
    return; // enabled but nowhere to poll — wait for a configured gateway
  }
  const ownProfileId = await deps.ownProfileId();
  if (ownProfileId === undefined) {
    return; // no profile yet → no route tags to subscribe (same rule as discovery)
  }
  const epoch = currentRoutingEpoch(Date.now());
  const routeTags = [epoch - 1n, epoch, epoch + 1n].map((e) => deriveRouteTag(ownProfileId, e));
  const createTransport =
    deps.createLoraTransport ?? ((config) => new LoraTransport(config) as LoraPollSource);
  const transport = createTransport({ baseUrl, routeTags });
  const since = await deps.cursors.get(LORA_CURSOR_NAME);
  const result = await transport.poll(since);
  // Same pipeline as chain discovery; the gateway is the funding source
  // for the pre-decryption budget (ADR 0007 question 3).
  const budget = new PreDecryptBudget(deps.preDecryptLimits);
  const gatewaySource = `lora:${baseUrl}`;
  // Deferred LoRa objects keep their bytes (the cursor moved past them).
  for (const due of await deps.dispositions.listDueDeferredWithData(Date.now())) {
    try {
      await ingestIncomingCellData(
        deps,
        ownProfileId,
        bytesToHex(due.cellData),
        null,
        budget,
        gatewaySource,
      );
    } catch {
      // isolated per object, as below
    }
  }
  for (const object of result.objects) {
    try {
      await ingestIncomingCellData(
        deps,
        ownProfileId,
        bytesToHex(object.cellData),
        null,
        budget,
        gatewaySource,
      );
    } catch {
      // One bad object never stalls the poll (rule 4): it is transport noise,
      // and message-id dedup keeps re-delivery from duplicating rows.
    }
  }
  if (result.cursor !== null) {
    await deps.cursors.set(LORA_CURSOR_NAME, result.cursor);
  }
}

/* ── response sender (§12 worker 6) ──────────────────────────────────────── */

/**
 * The two receipt-carrying response kinds, keyed by logical-id prefix.
 *
 * `response:` is the envelope ack (ADR 0005) — "I received and decrypted your
 * message" — and releases the sender's message cell. `ack-attachment:` is the
 * separate confirmation that the attachment BYTES were fetched, and is the
 * only thing that releases the sender's chunk cells. They are distinct rows so
 * a device that never taps to download simply never sends the second one, and
 * the sender correctly keeps the image alive.
 */
const RECEIPT_KINDS = [
  { prefix: "response:", status: 0x01 },
  { prefix: "ack-attachment:", status: 0x05 },
] as const;

/** The receipt kind a queued outgoing row encodes, or undefined if it is not one. */
function receiptKindOf(logicalMessageId: string): (typeof RECEIPT_KINDS)[number] | undefined {
  return RECEIPT_KINDS.find((kind) => logicalMessageId.startsWith(kind.prefix));
}

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
    (m) => m.direction === "outgoing" && receiptKindOf(m.logicalMessageId) !== undefined,
  );
  for (const response of queued) {
    // The response's chain ref names the ORIGINAL cell (reply_to fields),
    // and its logical id embeds the original incoming message's logical id.
    const chainRef = await deps.messages.getChainRef(response.id);
    if (chainRef?.replyToTxHash == null || chainRef.replyToOutpointIndex === null) {
      continue; // not fully prepared — the app completes the row first
    }
    const kind = receiptKindOf(response.logicalMessageId);
    if (kind === undefined) {
      continue;
    }
    const original = await deps.messages.getByLogicalId(
      response.logicalMessageId.slice(kind.prefix.length),
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
    // ADR 0006: the receipt carries a proof under the ORIGINAL message's
    // receipt key. No stored key (a legacy v1 message, or a row from before
    // the upgrade) means no proof is possible, and an unproven receipt would
    // be ignored by the sender anyway — leave the row queued, send nothing.
    const receiptKey = await deps.messages.getReceiptKey(original.id);
    if (receiptKey === null) {
      continue;
    }
    let proof: Uint8Array;
    try {
      proof = computeReceiptProof(receiptKey, originalEnvelopeMessageId, kind.status);
    } finally {
      receiptKey.fill(0);
    }
    await deps.publisher.publishText({
      messageRowId: response.id,
      logicalMessageId: response.logicalMessageId,
      text: response.body ?? "",
      recipientProfileIdHex: contact.profileIdHex,
      replyTo: {
        messageId: originalEnvelopeMessageId,
        outPoint: { txHash: chainRef.replyToTxHash, index: chainRef.replyToOutpointIndex },
      },
      receipts: [{ messageId: originalEnvelopeMessageId, status: kind.status, proof }],
    });
    // An attachment ack is a bare confirmation that the bytes were fetched: it
    // carries no reply semantics, so it must NOT re-walk the original's state
    // machine or register a second watch — the envelope ack already did both
    // when the message first arrived.
    if (kind.status !== 0x01) {
      continue;
    }
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
      // ADR 0007: only an authenticated row (or a pre-upgrade row, NULL
      // status, received under the old rules) is notified and acked; a
      // legacy-unverified row never is.
      await advanceIncomingToReceived(deps, message.id, message.state, {
        conversationId: message.conversationId,
        logicalMessageId: message.logicalMessageId,
        notify: message.authStatus !== "legacy-unverified",
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
    { reservedShannon: categories.reservedShannon },
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
      // THE CHUNK CELLS ARE THE IMAGE. Reclaim them only once the recipient
      // has confirmed downloading the bytes (spec §8 `0x05`), never merely on
      // the envelope ack that reclaimed the message cell — images are fetched
      // lazily on tap, so the two events can be far apart or the download may
      // never happen at all. Spending these early destroyed the image while
      // the recipient still showed "Tap to load"; the bytes exist nowhere else
      // (rule 3 keeps no plaintext copy), so it is unrecoverable.
      if (!withManifest.remoteDownloaded) {
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
