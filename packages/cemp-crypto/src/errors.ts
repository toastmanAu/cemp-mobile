/**
 * Error types for @cemp/crypto.
 *
 * Every cryptographic failure in this package — AEAD authentication failure,
 * decapsulation failure, invalid key/nonce sizes, envelopes rejected by
 * pre-decrypt validation — surfaces as {@link CempCryptoError} (spec §12.4).
 * Callers must be able to catch one error type without pattern-matching
 * library-internal errors from noble.
 *
 * AGENTS.md rule 2: error messages must never carry mnemonics, seeds, secret
 * keys, plaintext or decrypted payloads. Library errors are forwarded as
 * `cause` only when they cannot contain secret material (noble's AEAD/KEM
 * errors are fixed strings about tags, lengths and moduli).
 */

/** All cryptographic failures of @cemp/crypto are reported as this type. */
export class CempCryptoError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CempCryptoError";
  }
}
