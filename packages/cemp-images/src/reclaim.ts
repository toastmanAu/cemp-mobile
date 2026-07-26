/**
 * Attachment group reclaim (spec §9.5, Phase 10 tasks 14–15).
 *
 * Message cell + manifest root + every chunk cell go into ONE reclaim group
 * and one batched reclaim transaction. The group is journaled before
 * broadcast under `reclaim-attachment:<groupId hex>` (crash-resume replays
 * exactly that set — no orphan CKBFS cells, exit criterion). On commit the
 * released capacity returns to the operational wallet.
 *
 * Remote-reclaim detection (task 15) reuses the Phase 8 machinery: the
 * recipient watches the manifest root cell (`attachment:<id>` purpose) and
 * `pollWatchesOnce` prunes the record once the root is spent.
 */

import { buildReclaimTx, type CempMessageTypeRef } from "@cemp/ckb";
import type { TransactionLike } from "@ckb-ccc/core";
import {
  JournaledAbandonedError,
  resumeJournaledBroadcast,
  trackBroadcastSpend,
  waitForTransactionCommit,
} from "@cemp/ckb";
import { cccTransactionToWire, type CempClient } from "@cemp/ckb";
import type { MlDsaV2TxSigner } from "@cemp/ckb";
import type { Cell, OutPoint } from "@cemp/ckb";
import type { AttachmentChunkJournal } from "./send.js";

export interface AttachmentReclaimStore extends AttachmentChunkJournal {
  /**
   * Compare-and-swap (review E5/I-6): returns rows changed — exactly one
   * concurrent caller wins the transition, so overlapping engines cannot
   * double-release the same capacity.
   */
  markOutgoingTxStateIf(
    txHash: string,
    expectedFromState: string,
    state: string,
    committedAtMs?: number,
  ): Promise<number>;
  /**
   * Fund the reclaimable bucket (reserved → reclaimable) BEFORE release
   * (review M-1) — the release draws on it.
   */
  markCapacityReclaimable(amountShannon: string): Promise<void>;
  releaseReclaimedCapacity(amountShannon: string): Promise<void>;
  /** Write off reclaimable capacity burned as the reclaim tx's fee (review E7). */
  recordFeeBurn(amountShannon: string): Promise<void>;
}

export interface AttachmentGroupReclaimResult {
  readonly txHash: string;
  readonly cellCount: number;
  readonly releasedShannon: string;
  readonly resumed: boolean;
}

function groupPurpose(reclaimGroupId: Uint8Array): string {
  return `reclaim-attachment:${Array.from(reclaimGroupId, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Reclaim a full attachment group. `outpoints` = message cell + manifest
 * root + every chunk cell (all sender-owned, rule 9).
 */
export async function reclaimAttachmentGroup(
  deps: {
    client: CempClient;
    signer: MlDsaV2TxSigner;
    messageType: CempMessageTypeRef;
    store: AttachmentReclaimStore;
  },
  reclaimGroupId: Uint8Array,
  outpoints: readonly OutPoint[],
  options: { timeoutMs?: number } = {},
): Promise<AttachmentGroupReclaimResult | null> {
  const { client, signer, messageType, store } = deps;
  const purpose = groupPurpose(reclaimGroupId);

  // Resume: a journaled group reclaim still in flight (rule 5). Review
  // E1/E10: rebroadcast from the journaled signed bytes; on commit, release
  // the capacity recorded in the journal. Review I-4: a journaled tx that
  // can NEVER land is abandoned and falls through to a FRESH build from the
  // live-cell resolution below (mirroring publishAttachmentChunks).
  const journaled = await store.findLatestOutgoingTxByPurposePrefix(purpose);
  if (journaled !== undefined && journaled.state === "submitted") {
    try {
      const outcome = await resumeJournaledBroadcast(
        client,
        { txHash: journaled.txHash, txHex: journaled.txHex ?? null },
        {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
      );
      // A rebroadcast re-spends the journaled inputs: mark them so the next
      // build cannot re-select them (the F-1 double-spend gap one layer up).
      if (outcome === "rebroadcast" && journaled.txHex != null) {
        await trackBroadcastSpend(signer, JSON.parse(journaled.txHex) as TransactionLike);
      }
      // Review I-6: exactly one caller wins submitted→committed; only the
      // winner funds/releases capacity (no double-release across engines).
      const won = await store.markOutgoingTxStateIf(
        journaled.txHash,
        "submitted",
        "committed",
        Date.now(),
      );
      if (won === 0) {
        return {
          txHash: journaled.txHash,
          cellCount: outpoints.length,
          releasedShannon: "0",
          resumed: true,
        };
      }
      const released = await finalizeCommittedReclaim(
        store,
        journaled.capacityShannon ?? null,
        journaled.feeShannon ?? null,
      );
      return {
        txHash: journaled.txHash,
        cellCount: outpoints.length,
        releasedShannon: released,
        resumed: true,
      };
    } catch (error) {
      if (!(error instanceof JournaledAbandonedError)) {
        throw error;
      }
      // Review I-4: the journaled reclaim can NEVER land (rejected outright,
      // or its inputs were spent elsewhere). Abandon it and fall through to
      // a FRESH build from the live-cell resolution below — without this the
      // group wedged forever (the worker swallows the error per-group and
      // the journal stayed `submitted`).
      await store.markOutgoingTxState(journaled.txHash, "abandoned");
    }
  }

  if (outpoints.length === 0) {
    return null;
  }
  // Resolve the live cells; already-spent ones were ours (sender lock).
  const liveOutpoints: { txHash: string; index: string }[] = [];
  const resolvedCells: Cell[] = [];
  let releasedTotal = 0n;
  for (const outpoint of outpoints) {
    const status = await client.getLiveCell(outpoint);
    if (status.status === "live") {
      liveOutpoints.push(outpoint);
      resolvedCells.push(status.cell);
      releasedTotal += BigInt(status.cell.output.capacity);
    }
  }
  if (resolvedCells.length === 0) {
    return null; // everything already reclaimed earlier
  }

  const built = await buildReclaimTx({
    outpoints: liveOutpoints,
    resolvedCells,
    signer,
    messageTypeCellDep: messageType.cellDep,
  });
  const signed = await signer.signTransaction(built.tx);
  const txHash = signed.hash();
  // Rule 6: journal BEFORE broadcast, signed bytes included (review E1).
  const wire = cccTransactionToWire(signed);
  await store.recordOutgoingTx({
    txHash,
    purpose,
    state: "submitted",
    feeShannon: built.estimatedFee.toString(),
    capacityShannon: releasedTotal.toString(),
    txHex: JSON.stringify(wire),
    submittedAtMs: Date.now(),
  });
  const accepted = await client.sendTransaction(wire);
  if (accepted !== txHash) {
    throw new Error("reclaimAttachmentGroup: node returned a different tx hash");
  }
  // Mark the spend locally so the next build cannot re-select these inputs.
  await trackBroadcastSpend(signer, signed);
  await waitForTransactionCommit(client, txHash, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  // Review I-6: exactly one caller wins the commit transition; only the
  // winner funds/releases capacity.
  const wonCommit = await store.markOutgoingTxStateIf(txHash, "submitted", "committed", Date.now());
  if (wonCommit === 0) {
    return {
      txHash,
      cellCount: resolvedCells.length,
      releasedShannon: "0",
      resumed: false,
    };
  }
  const releasedNet = await finalizeCommittedReclaim(
    store,
    releasedTotal.toString(),
    built.estimatedFee.toString(),
  );
  return {
    txHash,
    cellCount: resolvedCells.length,
    releasedShannon: releasedNet,
    resumed: false,
  };
}

/**
 * Commit finalization for a group reclaim (review M-1/E7): fund the
 * reclaimable bucket with the full released capacity (reserved →
 * reclaimable), release it NET of the reclaim tx's fee (reclaimable →
 * available), and write the fee off as burned. Returns the net release.
 */
async function finalizeCommittedReclaim(
  store: AttachmentReclaimStore,
  capacityShannon: string | null,
  feeShannon: string | null,
): Promise<string> {
  const capacity = capacityShannon === null ? 0n : BigInt(capacityShannon);
  const fee = feeShannon === null ? 0n : BigInt(feeShannon);
  if (capacity > 0n) {
    await store.markCapacityReclaimable(capacity.toString());
  }
  const released = capacity > fee ? capacity - fee : 0n;
  if (released > 0n) {
    await store.releaseReclaimedCapacity(released.toString());
  }
  if (fee > 0n) {
    await store.recordFeeBurn(fee.toString());
  }
  return released.toString();
}
