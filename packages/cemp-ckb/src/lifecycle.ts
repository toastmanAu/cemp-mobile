/**
 * Response + reclaim lifecycle (spec Phase 8; "first true end-to-end MVP
 * milestone"). Three flows, all crash-resumable through the journal:
 *
 * A) **Ack processing (tasks 4–5):** a decrypted incoming reply carries
 *    receipts naming our outgoing envelope message ids. Each acknowledged
 *    message walks available_on_chain → downloaded_by_recipient →
 *    acknowledged → reclaim_queued.
 *
 * B) **Batch reclaim (tasks 6–8):** reclaim_queued messages are batched into
 *    one `buildReclaimTx` (journaled BEFORE broadcast under a purpose string
 *    that embeds the covered row ids — crash-resume replays exactly that
 *    set), and on commit the messages land in `reclaimed` and the released
 *    capacity returns to available balance.
 *
 * C) **Responder watch (tasks 9–12):** after sending a response, the
 *    responder watches the ORIGINAL cell's outpoint. When it is spent, the
 *    incoming message transitions to remote_reclaimed, the watch is pruned
 *    (temporary chain data), and the decrypted chat history is untouched
 *    (rule 8).
 */

import { buildReclaimTx, type CempMessageTypeRef } from "./builders.js";
import { CempCkbError, type CempClient } from "./client.js";
import type { IncomingTextMessage } from "./incoming.js";
import {
  JournaledAbandonedError,
  resumeJournaledBroadcast,
  waitForTransactionCommit,
} from "./monitor.js";
import type { MlDsaV2TxSigner } from "./signing.js";
import type { Cell, OutPoint } from "./types.js";
import { cccTransactionToWire } from "./wire.js";

/* ── store boundary ──────────────────────────────────────────────────────── */

export interface LifecycleMessage {
  readonly rowId: number;
  readonly state: string;
  readonly chainRef: { txHash: string; outpointIndex: number } | null;
}

export interface LifecycleWatch {
  readonly txHash: string;
  readonly outpointIndex: number;
  readonly purpose: string;
}

export interface LifecycleStore {
  transitionMessage(rowId: number, to: string): Promise<void>;
  setMessageChainRef(rowId: number, ref: { txHash: string; outpointIndex: number }): Promise<void>;
  findOutgoingByEnvelopeMessageId(
    envelopeMessageIdHex: string,
  ): Promise<{ rowId: number; state: string } | undefined>;
  listOutgoingByState(state: string): Promise<LifecycleMessage[]>;

  recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string | undefined;
    submittedAtMs?: number | undefined;
    capacityShannon?: string | undefined;
    /** The signed wire transaction as JSON (schema v6; stored BEFORE broadcast). */
    txHex?: string | undefined;
  }): Promise<void>;
  markOutgoingTxState(txHash: string, state: string, committedAtMs?: number): Promise<void>;
  /**
   * Compare-and-swap (review E5): returns rows changed — exactly one
   * concurrent caller wins the transition, so double-commit accounting is
   * impossible even without a lease.
   */
  markOutgoingTxStateIf(
    txHash: string,
    expectedFromState: string,
    state: string,
    committedAtMs?: number,
  ): Promise<number>;
  /** Latest journaled tx whose purpose starts with `prefix` (batch resume). */
  findLatestOutgoingTxByPurposePrefix(prefix: string): Promise<
    | {
        txHash: string;
        state: string;
        purpose: string;
        capacityShannon: string | null;
        feeShannon: string | null;
        txHex: string | null;
      }
    | undefined
  >;

  /** Reserve message-cell capacity at commit time (Phase 8 accounting). */
  reserveCapacity(amountShannon: string): Promise<void>;
  /** Move capacity to reclaimable when a message is acked (review E3). */
  markCapacityReclaimable(amountShannon: string): Promise<void>;
  /** Journal info for a message row (review E3 accounting + resume). */
  getMessageJournalInfo(
    rowId: number,
  ): Promise<{ logicalMessageId: string; capacityShannon: string | null } | undefined>;

  registerWatch(input: { txHash: string; outpointIndex: number; purpose: string }): Promise<void>;
  listActiveWatches(): Promise<LifecycleWatch[]>;
  markWatchSpent(txHash: string, outpointIndex: number, spentByTxHash: string): Promise<void>;
  pruneSpentWatches(): Promise<number>;

  /** Return reclaimed capacity to the available balance (task 8). */
  releaseReclaimedCapacity(amountShannon: string): Promise<void>;
  /** Write off reclaimable capacity burned as the reclaim tx's fee (review E7). */
  recordFeeBurn(amountShannon: string): Promise<void>;
}

/* ── service ─────────────────────────────────────────────────────────────── */

export interface ResponseLifecycleDeps {
  readonly client: CempClient;
  readonly signer: MlDsaV2TxSigner;
  readonly messageType: CempMessageTypeRef;
  readonly store: LifecycleStore;
}

export interface ReclaimBatchResult {
  readonly txHash: string;
  readonly reclaimedRowIds: number[];
  readonly releasedShannon: string;
  readonly resumed: boolean;
  /** The journaled tx was never seen and its batch was requeued (review E1). */
  readonly abandoned?: boolean;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** States an outgoing message must be in for an ack to advance it. */
const ACKABLE_STATES = new Set(["available_on_chain", "downloaded_by_recipient", "acknowledged"]);

export class ResponseLifecycle {
  readonly #deps: ResponseLifecycleDeps;

  constructor(deps: ResponseLifecycleDeps) {
    this.#deps = deps;
  }

  /* ------------------------------------ A) ack processing (tasks 4–5) -- */

  /**
   * Apply the receipts of a decrypted incoming reply: each 0x01 receipt
   * acknowledging one of OUR outgoing envelope message ids advances that
   * message to `reclaim_queued`. Unknown ids are skipped silently (the reply
   * may reference messages of another device). Returns the acked row ids.
   */
  async processAcknowledgements(incoming: IncomingTextMessage): Promise<number[]> {
    const acked: number[] = [];
    for (const receipt of incoming.receipts) {
      if (receipt.status !== 0x01) {
        continue;
      }
      const found = await this.#deps.store.findOutgoingByEnvelopeMessageId(
        bytesToHex(receipt.messageId),
      );
      if (found === undefined || !ACKABLE_STATES.has(found.state)) {
        continue;
      }
      if (found.state === "available_on_chain") {
        await this.#deps.store.transitionMessage(found.rowId, "downloaded_by_recipient");
      }
      if (found.state !== "acknowledged") {
        await this.#deps.store.transitionMessage(found.rowId, "acknowledged");
      }
      await this.#deps.store.transitionMessage(found.rowId, "reclaim_queued");
      // Review E3: fund the reclaimable bucket from the journal's recorded
      // cell capacity, so the later release has something to release.
      const journal = await this.#deps.store.getMessageJournalInfo(found.rowId);
      if (journal?.capacityShannon != null) {
        await this.#deps.store.markCapacityReclaimable(journal.capacityShannon);
      }
      acked.push(found.rowId);
    }
    return acked;
  }

  /* ------------------------------------- B) batch reclaim (tasks 6–8) -- */

  /**
   * Execute one reclaim batch (or resume a journaled one). Idempotent:
   * re-running after any crash either resumes the journaled tx or collects
   * whatever is still in reclaim_queued/reclaim_pending.
   */
  async executeReclaimBatch(
    options: { timeoutMs?: number } = {},
  ): Promise<ReclaimBatchResult | null> {
    const { store } = this.#deps;

    // Resume: a journaled reclaim tx whose batch is still uncommitted.
    // Review E1: rebroadcast from the journaled signed bytes when the network
    // never saw the tx; abandon + requeue (retry edge) instead of wedging.
    const journaled = await store.findLatestOutgoingTxByPurposePrefix("reclaim:");
    if (journaled !== undefined && journaled.state === "submitted") {
      const ids = parseReclaimPurpose(journaled.purpose);
      try {
        await resumeJournaledBroadcast(
          this.#deps.client,
          { txHash: journaled.txHash, txHex: journaled.txHex },
          { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
        );
      } catch (e) {
        if (!(e instanceof JournaledAbandonedError)) {
          throw e;
        }
        // Abandoned: the tx never landed (or its inputs were spent elsewhere).
        // Mark the journal abandoned and requeue the batch — a future run
        // rebuilds with live inputs (retry edge, review E1/E2).
        await store.markOutgoingTxState(journaled.txHash, "abandoned");
        for (const rowId of ids) {
          await store.transitionMessage(rowId, "reclaim_queued");
        }
        return {
          txHash: journaled.txHash,
          reclaimedRowIds: [],
          releasedShannon: "0",
          resumed: false,
          abandoned: true,
        };
      }
      // Review E5: exactly one concurrent caller wins submitted→committed;
      // capacity is released only by the winner (no double-credit).
      const won = await store.markOutgoingTxStateIf(
        journaled.txHash,
        "submitted",
        "committed",
        Date.now(),
      );
      if (won === 0) {
        return {
          txHash: journaled.txHash,
          reclaimedRowIds: ids,
          releasedShannon: "0",
          resumed: true,
        };
      }
      // Review E7: the released amount is net of the journaled fee.
      const journaledFee = journaled.feeShannon === null ? 0n : BigInt(journaled.feeShannon);
      const journaledCapacity =
        journaled.capacityShannon === null ? 0n : BigInt(journaled.capacityShannon);
      const released =
        journaledCapacity > journaledFee ? (journaledCapacity - journaledFee).toString() : "0";
      for (const rowId of ids) {
        await store.transitionMessage(rowId, "reclaimed");
      }
      if (released !== "0") {
        await store.releaseReclaimedCapacity(released);
      }
      if (journaledFee > 0n) {
        await store.recordFeeBurn(journaledFee.toString());
      }
      return {
        txHash: journaled.txHash,
        reclaimedRowIds: ids,
        releasedShannon: released,
        resumed: true,
      };
    }

    // Collect candidates (reclaim_pending without a journal = crash recovery).
    const candidates = [
      ...(await store.listOutgoingByState("reclaim_queued")),
      ...(await store.listOutgoingByState("reclaim_pending")),
    ].filter((m) => m.chainRef !== null);
    if (candidates.length === 0) {
      return null;
    }

    // Resolve the live cells; a cell already gone can only have been spent by
    // an earlier reclaim of ours (sender lock) — mark it reclaimed and skip.
    // Review E4: only an explicit `dead` status counts as spent; `unknown`
    // means the node has no information — leave queued, retry next round
    // (never mark irreversible state from one unverified answer).
    const outpoints: { txHash: string; index: string }[] = [];
    const resolvedCells: Cell[] = [];
    const covered: LifecycleMessage[] = [];
    let releasedTotal = 0n;
    for (const message of candidates) {
      const ref = message.chainRef!;
      const outPoint: OutPoint = {
        txHash: ref.txHash,
        index: `0x${ref.outpointIndex.toString(16)}`,
      };
      const status = await this.#deps.client.getLiveCell(outPoint);
      if (status.status === "live") {
        outpoints.push({ txHash: ref.txHash, index: outPoint.index });
        resolvedCells.push(status.cell);
        covered.push(message);
        releasedTotal += BigInt(status.cell.output.capacity);
      } else if (status.status === "dead") {
        // Already spent by us (prior reclaim committed while we were offline).
        // Review E2: walk the legal path (reclaim_queued → reclaim_pending →
        // reclaimed — the direct edge does not exist).
        await store.transitionMessage(message.rowId, "reclaim_pending");
        await store.transitionMessage(message.rowId, "reclaimed");
      }
      // `unknown`: no information this round — leave queued, retry later.
    }
    if (covered.length === 0) {
      return null;
    }

    for (const message of covered) {
      await store.transitionMessage(message.rowId, "reclaim_pending");
    }

    const built = await buildReclaimTx({
      outpoints,
      resolvedCells,
      signer: this.#deps.signer,
      messageTypeCellDep: this.#deps.messageType.cellDep,
    });
    const signed = await this.#deps.signer.signTransaction(built.tx);
    const txHash = signed.hash();

    // Journal BEFORE broadcast (rule 6): the purpose embeds the covered set,
    // and the signed wire bytes are stored for rebroadcast resume (review E1).
    const ids = covered.map((m) => m.rowId);
    const wire = cccTransactionToWire(signed);
    await store.recordOutgoingTx({
      txHash,
      purpose: `reclaim:${ids.join(",")}`,
      state: "submitted",
      feeShannon: built.estimatedFee.toString(),
      capacityShannon: releasedTotal.toString(),
      txHex: JSON.stringify(wire),
      submittedAtMs: Date.now(),
    });

    const accepted = await this.#deps.client.sendTransaction(wire);
    if (accepted !== txHash) {
      throw new CempCkbError(
        "lifecycle",
        "node returned a tx hash different from the signed reclaim",
      );
    }
    await waitForTransactionCommit(this.#deps.client, txHash, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    // Review E5: exactly one caller wins the commit transition; only the
    // winner releases capacity.
    const wonCommit = await store.markOutgoingTxStateIf(
      txHash,
      "submitted",
      "committed",
      Date.now(),
    );
    if (wonCommit === 0) {
      return {
        txHash,
        reclaimedRowIds: ids,
        releasedShannon: "0",
        resumed: false,
      };
    }
    for (const message of covered) {
      await store.transitionMessage(message.rowId, "reclaimed");
      // Any sender-side ack-watch on the reclaimed cell is now moot (task 11).
      const ref = message.chainRef!;
      const watch = (await store.listActiveWatches()).find(
        (w) => w.txHash === ref.txHash && w.outpointIndex === ref.outpointIndex,
      );
      if (watch !== undefined) {
        await store.markWatchSpent(ref.txHash, ref.outpointIndex, txHash);
      }
    }
    // Review E7: released capacity is net of the fee actually burned.
    const releasedNet = releasedTotal - built.estimatedFee;
    if (releasedNet > 0n) {
      await store.releaseReclaimedCapacity(releasedNet.toString());
    }
    if (built.estimatedFee > 0n) {
      await store.recordFeeBurn(built.estimatedFee.toString());
    }
    await store.pruneSpentWatches();
    return {
      txHash,
      reclaimedRowIds: ids,
      releasedShannon: releasedNet > 0n ? releasedNet.toString() : "0",
      resumed: false,
    };
  }

  /* ---------------------------------- C) responder watch (tasks 9–12) -- */

  /**
   * After the response tx is committed: mark the response message
   * awaiting_remote_reclaim and register the watch on the ORIGINAL cell's
   * outpoint (task 9).
   */
  async finalizeResponseSent(input: {
    responseRowId: number;
    originalOutpoint: { txHash: string; index: number };
  }): Promise<void> {
    await this.#deps.store.transitionMessage(input.responseRowId, "awaiting_remote_reclaim");
    await this.#deps.store.registerWatch({
      txHash: input.originalOutpoint.txHash,
      outpointIndex: input.originalOutpoint.index,
      purpose: `response:${input.responseRowId}`,
    });
  }

  /**
   * One-shot watch poll (task 10): for every active watch, a spent outpoint
   * transitions its response message to remote_reclaimed; spent watches are
   * then pruned (task 11). Chat history is never touched (task 12, rule 8).
   * Returns the purposes of the watches that were spent.
   */
  async pollWatchesOnce(): Promise<string[]> {
    const { store } = this.#deps;
    const spentPurposes: string[] = [];
    for (const watch of await store.listActiveWatches()) {
      const outPoint: OutPoint = {
        txHash: watch.txHash,
        index: `0x${watch.outpointIndex.toString(16)}`,
      };
      const status = await this.#deps.client.getLiveCell(outPoint);
      if (status.status === "live") {
        continue;
      }
      if (status.status === "unknown") {
        // Review E4: `unknown` means the NODE has no information — not that
        // the cell is gone. Leave the watch active and retry next poll; never
        // flip irreversible state from one unverified answer.
        continue;
      }
      // Explicitly dead: the cell is gone. The spender is not resolvable
      // through get_live_cell — recorded as a sentinel; the watch is pruned
      // immediately after, so the sentinel never collides with a real hash.
      await store.markWatchSpent(watch.txHash, watch.outpointIndex, "unknown-spender");
      const rowId = parseWatchPurpose(watch.purpose);
      if (rowId !== null) {
        // By construction a response:<rowId> watch only exists after
        // finalizeResponseSent moved the message to awaiting_remote_reclaim,
        // so this transition is always legal.
        await store.transitionMessage(rowId, "remote_reclaimed");
      }
      spentPurposes.push(watch.purpose);
    }
    if (spentPurposes.length > 0) {
      await store.pruneSpentWatches();
    }
    return spentPurposes;
  }
}

/** `reclaim:<id,id,…>` → the covered row ids. */
export function parseReclaimPurpose(purpose: string): number[] {
  const body = purpose.startsWith("reclaim:") ? purpose.slice("reclaim:".length) : "";
  if (body === "") {
    return [];
  }
  return body.split(",").map((part) => {
    const id = Number(part);
    if (!Number.isInteger(id) || id <= 0) {
      throw new CempCkbError("lifecycle", `malformed reclaim purpose ${purpose}`);
    }
    return id;
  });
}

/** `response:<rowId>` → the response message row id, or null for other watches. */
function parseWatchPurpose(purpose: string): number | null {
  if (!purpose.startsWith("response:")) {
    return null;
  }
  const id = Number(purpose.slice("response:".length));
  return Number.isInteger(id) && id > 0 ? id : null;
}
