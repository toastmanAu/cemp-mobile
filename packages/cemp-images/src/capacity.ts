/**
 * Pre-flight capacity gate for an image send (spec §4 decision 5A). On-chain
 * storage costs ~1 CKB per byte, so an image locks roughly its own size in CKB.
 * This estimates the required locked capacity BEFORE building the tx, so an
 * under-funded wallet fails fast with no stranded pending row. The real tx
 * build enforces exact capacity; this is a conservative UPPER bound: it never
 * gives a false "OK" (an affordable-on-paper send can't strand mid-build),
 * at the price of occasionally refusing a send that just barely fit (the
 * margin is small — per-chunk overhead + a 1 CKB fee reserve).
 */

import { ATTACHMENT_CHUNK_BYTES } from "./encrypt.js";

const SHANNON_PER_CKB = 100_000_000n;

/** 1 CKB fee reserve (pessimistic; real fee is far smaller). */
export const SEND_FEE_RESERVE_SHANNONS = 1n * SHANNON_PER_CKB;

/**
 * Upper-bound capacity for one full chunk cell: 32 KiB data + generous cell
 * overhead (capacity field + ML-DSA lock + type script ≈ 256 bytes). Task 13
 * may refine from the actual built cell; this bound guarantees no false "OK".
 */
export const CONSERVATIVE_PER_CHUNK_SHANNON =
  (BigInt(ATTACHMENT_CHUNK_BYTES) + 256n) * SHANNON_PER_CKB;

/**
 * Upper-bound capacity for the manifest-carrying message cell: the envelope +
 * manifest (incl. ≤32 KiB thumbnail) + cell overhead, bounded generously.
 *
 * ADR 0007: a v3 envelope also carries the 3,309-byte ML-DSA-65 signature,
 * so the bound is 32 KiB + 8 KiB. Measured: the largest v3 manifest cell
 * (32 KiB thumbnail, 33 chunks) occupies ~39,917 CKB incl. the 1 CKB builder
 * margin; the old 36,864 CKB bound under-counted it (capacity.test.ts).
 */
export const CONSERVATIVE_MESSAGE_CELL_SHANNON = (32_768n + 8_192n) * SHANNON_PER_CKB;

export function estimateImageSendShannon(input: {
  readonly chunkCount: number;
  readonly perChunkShannon: bigint;
  readonly messageCellShannon: bigint;
  readonly feeReserveShannon: bigint;
}): bigint {
  return (
    BigInt(input.chunkCount) * input.perChunkShannon +
    input.messageCellShannon +
    input.feeReserveShannon
  );
}

export function hasSufficientCapacity(availableShannon: bigint, requiredShannon: bigint): boolean {
  return availableShannon >= requiredShannon;
}
