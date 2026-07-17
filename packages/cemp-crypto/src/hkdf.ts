import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { KdfDomain, MessageKeyDomain } from "./domains.js";

const textEncoder = new TextEncoder();

export const HKDF_SHA256_DEFAULT_LENGTH = 32;

/**
 * HKDF-SHA-256 (RFC 5869). This replaces the prototype's ad-hoc
 * "shared secret through personalised BLAKE2b" construction (spec §14.1).
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | string,
  length: number = HKDF_SHA256_DEFAULT_LENGTH,
): Uint8Array {
  const infoBytes = typeof info === "string" ? textEncoder.encode(info) : info;
  return hkdf(sha256, ikm, salt, infoBytes, length);
}

/**
 * Derive an independent sub-seed from the BIP39 root seed using an explicit
 * domain string (spec §5.1). BIP39 is the recovery container; domain-separated
 * HKDF is the deterministic key derivation mechanism. Non-hardened BIP32
 * derivation must NOT be used for post-quantum private keys.
 */
export function deriveSubSeed(
  bip39Seed: Uint8Array,
  domain: KdfDomain,
  length: number = HKDF_SHA256_DEFAULT_LENGTH,
): Uint8Array {
  return hkdfSha256(bip39Seed, undefined, domain, length);
}

/**
 * Message key from an ML-KEM shared secret (spec §14.1):
 *
 *   PRK         = HKDF-Extract(salt = envelope_nonce, IKM = ml_kem_shared_secret)
 *   message_key = HKDF-Expand(PRK, "CEMP-MESSAGE-KEY-V1" || sender_id || recipient_id, 32)
 */
export function deriveMessageKey(
  mlKemSharedSecret: Uint8Array,
  envelopeNonce: Uint8Array,
  senderProfileId: Uint8Array,
  recipientProfileId: Uint8Array,
  domain: MessageKeyDomain = "CEMP-MESSAGE-KEY-V1",
): Uint8Array {
  const info = concatBytes(textEncoder.encode(domain), senderProfileId, recipientProfileId);
  return hkdfSha256(mlKemSharedSecret, envelopeNonce, info);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
