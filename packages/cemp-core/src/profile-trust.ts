/**
 * Contact profile trust evaluation (spec §10.3, Phase 5 task 7 + exit
 * criterion "unexpected profile key changes generate a blocking warning").
 *
 * Two pieces:
 *
 * - {@link validateRotationChain} — structural validation of a profile
 *   key-rotation chain (protocol §5): sequence starts at 0, increments by
 *   exactly 1, and each link's `previous_profile_id` names the predecessor's
 *   profile id. (The cryptographic half — the old lock signed the rotation
 *   transaction spending its cell — is enforced on-chain by the lock script.)
 *
 * - {@link evaluateContactProfile} — the verdict a contact screen blocks on:
 *   `first-use` (never seen — TOFU), `trusted` (keys unchanged),
 *   `rotation-verified` (keys changed, but a valid chain links the saved
 *   lineage to the new profile), or `key-changed-blocking` (keys changed with
 *   NO valid chain — a blocking warning, spec Phase 5 exit criterion).
 */

export interface ProfileTrustView {
  /** 32-byte profile id (Type ID args of the profile cell). */
  readonly profileId: Uint8Array;
  readonly mlDsaPublicKey: Uint8Array;
  readonly mlKemPublicKey: Uint8Array;
  readonly rotationSequence: number;
  /** Previous profile id when rotated (null for rotation_sequence 0). */
  readonly previousProfileId: Uint8Array | null;
  readonly revoked: boolean;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface RotationChainResult {
  readonly valid: boolean;
  /** Human-readable structural failure (no key material), when invalid. */
  readonly reason?: string;
}

/** Structural validation of an ordered rotation chain (oldest first). */
export function validateRotationChain(chain: readonly ProfileTrustView[]): RotationChainResult {
  if (chain.length === 0) {
    return { valid: false, reason: "empty chain" };
  }
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i]!;
    if (link.rotationSequence !== i) {
      return {
        valid: false,
        reason: `rotation sequence ${String(link.rotationSequence)} at position ${String(i)} (must increment by 1 from 0)`,
      };
    }
    if (i === 0) {
      if (link.previousProfileId !== null) {
        return { valid: false, reason: "the chain root names a previous profile" };
      }
    } else {
      const previous = chain[i - 1]!;
      if (
        link.previousProfileId === null ||
        !bytesEqual(link.previousProfileId, previous.profileId)
      ) {
        return {
          valid: false,
          reason: `link ${String(i)} does not name its predecessor's profile id`,
        };
      }
    }
  }
  return { valid: true };
}

export type ContactTrustVerdict =
  "first-use" | "trusted" | "rotation-verified" | "key-changed-blocking";

export interface ContactTrustResult {
  readonly verdict: ContactTrustVerdict;
  /** Blocking-warning text for the UI when the verdict requires it. */
  readonly warning?: string;
}

export interface SavedContactProfile {
  readonly profileId: Uint8Array;
  readonly mlDsaPublicKey: Uint8Array;
  readonly mlKemPublicKey: Uint8Array;
}

/**
 * Evaluate a freshly fetched profile against what we have saved for a
 * contact. `chain` is the fetched rotation chain (oldest first, ending at
 * `fetched`) — required whenever keys differ.
 */
export function evaluateContactProfile(
  saved: SavedContactProfile | null,
  fetched: ProfileTrustView,
  chain: readonly ProfileTrustView[],
): ContactTrustResult {
  if (saved === null) {
    return { verdict: "first-use" };
  }
  const keysUnchanged =
    bytesEqual(saved.mlDsaPublicKey, fetched.mlDsaPublicKey) &&
    bytesEqual(saved.mlKemPublicKey, fetched.mlKemPublicKey) &&
    bytesEqual(saved.profileId, fetched.profileId);
  if (keysUnchanged) {
    return { verdict: "trusted" };
  }
  // Keys (or profile id) changed: only a valid rotation chain from the SAVED
  // profile id to the fetched profile clears the warning.
  const chainResult = validateRotationChain(chain);
  if (chainResult.valid && chain.length > 0) {
    const root = chain[0]!;
    const tip = chain[chain.length - 1]!;
    const chainLinksSavedToFetched =
      bytesEqual(root.profileId, saved.profileId) && bytesEqual(tip.profileId, fetched.profileId);
    if (chainLinksSavedToFetched) {
      return { verdict: "rotation-verified" };
    }
  }
  return {
    verdict: "key-changed-blocking",
    warning:
      "This contact's profile keys changed without a valid rotation chain. " +
      "Verify the new fingerprint with the contact through another channel before continuing.",
  };
}
