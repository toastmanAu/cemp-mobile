/**
 * Transaction-graph rotation verification (review Finding A, 2026-07-18).
 *
 * `validateRotationChain` (cemp-core) performs only STRUCTURAL checks over
 * caller-supplied views: sequence increments and `previous_profile_id` byte-
 * equality. That is forgeable — anyone can mint a Type-ID cell whose data
 * claims any `previous_profile_id`, and the structural check would accept it
 * once profile-rotation discovery ships. The spec promises "signature
 * continuity" (CEMP-PROTOCOL-V1 §5); the structural check does not provide it.
 *
 * This module adds the missing binding, client-side, without a schema change:
 * for each claimed link (predecessor → successor), fetch the transaction that
 * created the successor's profile cell and confirm it CONSUMED the
 * predecessor's outpoint. Because the predecessor cell's lock script executed
 * to unlock that input, the link is authorized by the retiring key — exactly
 * the continuity the spec promises. A forged cell (whose creating tx consumed
 * some other input) fails the check.
 */

import { CempCkbError, type CempClient } from "./client.js";
import type { ResolvedProfile } from "./profiles.js";
import type { OutPoint } from "./types.js";

export interface RotationPredecessorRef {
  /** The retired profile cell's outpoint (the one a real rotation spends). */
  readonly outPoint: OutPoint;
  /** The retired profile id (the predecessor cell's type args, 0x-prefixed). */
  readonly profileIdHex: string;
}

function sameOutPoint(a: OutPoint, b: OutPoint): boolean {
  return a.txHash.toLowerCase() === b.txHash.toLowerCase() && BigInt(a.index) === BigInt(b.index);
}

/**
 * Verify one rotation link on-chain:
 *
 * 1. The successor cell's own type args are the claimed profile id (binding
 *    the cell to the identity, not just its data).
 * 2. The transaction that created the successor cell consumed the
 *    predecessor's outpoint as an input — the retiring lock authorized it.
 * 3. The successor's `previous_profile_id` data field names the predecessor's
 *    profile id (structural consistency with the tx graph).
 *
 * Throws {@link CempCkbError} with context "rotation-verify" on ANY failure —
 * callers map it to the `key-changed-blocking` verdict, never to a warning
 * the user could tap past.
 */
export async function verifyRotationLinkOnChain(
  client: CempClient,
  predecessor: RotationPredecessorRef,
  successor: ResolvedProfile,
): Promise<void> {
  // (1) The successor's type args are the profile id its data claims to succeed.
  const typeArgs = successor.cell.output.type?.args;
  if (typeArgs === undefined) {
    throw new CempCkbError("rotation-verify", "successor cell has no type script");
  }
  // (2) Its creating transaction consumed the predecessor outpoint.
  const creatingTxHash = successor.cell.outPoint.txHash;
  const body = await client.getTransactionBody(creatingTxHash);
  if (body === null) {
    throw new CempCkbError(
      "rotation-verify",
      `node does not know the creating tx ${creatingTxHash}`,
    );
  }
  const consumed = body.inputs.some((input) =>
    sameOutPoint(
      { txHash: input.previousOutput.txHash, index: input.previousOutput.index },
      predecessor.outPoint,
    ),
  );
  if (!consumed) {
    throw new CempCkbError(
      "rotation-verify",
      "the successor's creating transaction did not consume the claimed predecessor cell",
    );
  }
  // (3) The data-level back-reference names the predecessor profile id.
  const backRef = successor.profile.previous_profile_id;
  if (backRef === undefined) {
    throw new CempCkbError("rotation-verify", "successor profile has no previous_profile_id");
  }
  const backRefHex = `0x${Array.from(backRef, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (backRefHex.toLowerCase() !== predecessor.profileIdHex.toLowerCase()) {
    throw new CempCkbError(
      "rotation-verify",
      "previous_profile_id does not name the consumed predecessor's profile id",
    );
  }
}

/**
 * Verify a full rotation chain on-chain, newest link last. Every link must
 * pass {@link verifyRotationLinkOnChain} with the predecessor's outpoint
 * resolved live (dead is expected — it was consumed).
 */
export async function verifyRotationChainOnChain(
  client: CempClient,
  links: readonly { predecessor: RotationPredecessorRef; successor: ResolvedProfile }[],
): Promise<void> {
  if (links.length === 0) {
    throw new CempCkbError("rotation-verify", "empty rotation chain");
  }
  for (const [index, link] of links.entries()) {
    try {
      await verifyRotationLinkOnChain(client, link.predecessor, link.successor);
    } catch (e) {
      throw new CempCkbError(
        "rotation-verify",
        `link ${String(index)} failed: ${(e as Error).message}`,
      );
    }
  }
}
