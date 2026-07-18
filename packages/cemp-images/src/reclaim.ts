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
import { resumeJournaledBroadcast, waitForTransactionCommit } from "@cemp/ckb";
import { cccTransactionToWire, type CempClient } from "@cemp/ckb";
import type { MlDsaV2TxSigner } from "@cemp/ckb";
import type { Cell, OutPoint } from "@cemp/ckb";
import type { AttachmentChunkJournal } from "./send.js";

export interface AttachmentReclaimStore extends AttachmentChunkJournal {
  releaseReclaimedCapacity(amountShannon: string): Promise<void>;
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
  // the capacity recorded in the journal.
  const journaled = await store.findLatestOutgoingTxByPurposePrefix(purpose);
  if (journaled !== undefined && journaled.state === "submitted") {
    await resumeJournaledBroadcast(
      client,
      { txHash: journaled.txHash, txHex: journaled.txHex ?? null },
      {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
    );
    await store.markOutgoingTxState(journaled.txHash, "committed", Date.now());
    const released =
      "capacityShannon" in journaled && typeof journaled.capacityShannon === "string"
        ? (journaled.capacityShannon as string)
        : "0";
    if (released !== "0") {
      await store.releaseReclaimedCapacity(released);
    }
    return {
      txHash: journaled.txHash,
      cellCount: outpoints.length,
      releasedShannon: released,
      resumed: true,
    };
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
  await waitForTransactionCommit(client, txHash, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  await store.markOutgoingTxState(txHash, "committed", Date.now());
  await store.releaseReclaimedCapacity(releasedTotal.toString());
  return {
    txHash,
    cellCount: resolvedCells.length,
    releasedShannon: releasedTotal.toString(),
    resumed: false,
  };
}
