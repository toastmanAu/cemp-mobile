/**
 * Profile identity fingerprints (spec §10.3, Phase 5 task 8).
 *
 *   fingerprint = blake2b-256(personal "cemp-fingerprint",
 *                   profile_id ‖ ml_dsa_public_key ‖ ml_kem_public_key)[0..16]
 *
 * displayed as 8 dash-separated groups of 4 uppercase hex characters
 * ("ABCD-1234-…", the spec §5.4 bundle example). The BLAKE2b
 * personalisation string IS the version marker (rule 13): changing the
 * construction means changing the personalisation, never reusing it.
 *
 * Fingerprints are compared by users out-of-band (safety-number style): the
 * comparison input is the text form, so {@link parseFingerprint} accepts the
 * dashed/undashed/lower-case forms users actually type.
 */

import { blake2b } from "@noble/hashes/blake2.js";

/** BLAKE2b personalisation — the fingerprint construction's version marker. */
export const FINGERPRINT_PERSONAL = "cemp-fingerprint";
/** Raw fingerprint length before formatting (16 bytes → 32 hex chars). */
export const FINGERPRINT_BYTES = 16;

const PERSONAL_BYTES = (() => {
  const bytes = new TextEncoder().encode(FINGERPRINT_PERSONAL);
  if (bytes.length !== 16) {
    throw new Error("FINGERPRINT_PERSONAL must be exactly 16 bytes");
  }
  return bytes;
})();

export interface FingerprintInput {
  /** 32-byte profile id (the profile cell's Type ID args). */
  readonly profileId: Uint8Array;
  /** 1952-byte ML-DSA-65 public key. */
  readonly mlDsaPublicKey: Uint8Array;
  /** 1184-byte ML-KEM-768 public key. */
  readonly mlKemPublicKey: Uint8Array;
}

/** Raw 16-byte fingerprint (binary form, e.g. for storage). */
export function fingerprintBytes(input: FingerprintInput): Uint8Array {
  if (input.profileId.length !== 32) {
    throw new Error(`fingerprint: profileId length ${input.profileId.length} != 32`);
  }
  const joined = new Uint8Array(
    input.profileId.length + input.mlDsaPublicKey.length + input.mlKemPublicKey.length,
  );
  joined.set(input.profileId, 0);
  joined.set(input.mlDsaPublicKey, input.profileId.length);
  joined.set(input.mlKemPublicKey, input.profileId.length + input.mlDsaPublicKey.length);
  return blake2b(joined, { dkLen: FINGERPRINT_BYTES, personalization: PERSONAL_BYTES });
}

/** Display form: 8 groups of 4 uppercase hex chars ("XXXX-XXXX-…-XXXX"). */
export function formatFingerprint(input: FingerprintInput): string {
  const hex = Array.from(fingerprintBytes(input), (b) => b.toString(16).padStart(2, "0")).join("");
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    groups.push(hex.slice(i, i + 4));
  }
  return groups.join("-").toUpperCase();
}

/**
 * Parse a user-typed fingerprint back to its canonical display form
 * (accepts dashed/undashed, any case). Throws on anything malformed.
 */
export function parseFingerprint(text: string): string {
  const compact = text.replace(/-/g, "");
  if (compact.length !== FINGERPRINT_BYTES * 2 || !/^[0-9A-Fa-f]+$/.test(compact)) {
    throw new Error("fingerprint: expected 32 hex characters (8 groups of 4)");
  }
  const groups: string[] = [];
  for (let i = 0; i < compact.length; i += 4) {
    groups.push(compact.slice(i, i + 4).toUpperCase());
  }
  return groups.join("-");
}

/** Whether two display-form fingerprints are the same (format-normalised). */
export function fingerprintsEqual(a: string, b: string): boolean {
  try {
    return parseFingerprint(a) === parseFingerprint(b);
  } catch {
    return false;
  }
}
