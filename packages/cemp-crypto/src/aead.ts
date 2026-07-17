/**
 * AES-256-GCM via @noble/ciphers (spec §3: family 0x03, parameter 1).
 *
 * Pure JavaScript — Web Crypto (`crypto.subtle`) is deliberately not used
 * because it is unavailable under Hermes/React Native. The output layout is
 * `ciphertext ‖ 16-byte tag`, matching `CempEnvelopeV1.encrypted_payload`
 * (spec §7).
 */

import { gcm } from "@noble/ciphers/aes.js";
import { CempCryptoError } from "./errors.js";

/** AES-256 key size (spec §3). */
export const AES_256_KEY_BYTES = 32;
/** AES-GCM nonce size (spec §2). */
export const AES_256_GCM_NONCE_BYTES = 12;
/** AES-GCM authentication tag size, appended to the ciphertext (spec §2). */
export const AES_256_GCM_TAG_BYTES = 16;

function checkKeyAndNonce(key: Uint8Array, nonce: Uint8Array): void {
  if (key.length !== AES_256_KEY_BYTES) {
    throw new CempCryptoError(`aes256Gcm: key length ${key.length} != ${AES_256_KEY_BYTES}`);
  }
  if (nonce.length !== AES_256_GCM_NONCE_BYTES) {
    throw new CempCryptoError(
      `aes256Gcm: nonce length ${nonce.length} != ${AES_256_GCM_NONCE_BYTES}`,
    );
  }
}

/**
 * Encrypt `plaintext` under AES-256-GCM with additional authenticated data
 * `aad`. Returns `ciphertext ‖ tag` (tag = 16 bytes, appended by noble).
 */
export function aes256GcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  checkKeyAndNonce(key, nonce);
  return gcm(key, nonce, aad).encrypt(plaintext);
}

/**
 * Decrypt `ciphertextWithTag` (`ciphertext ‖ 16-byte tag`) and verify the tag
 * against `aad`. Throws {@link CempCryptoError} on any authentication or
 * format failure — no partial plaintext is ever returned (spec §12.4).
 */
export function aes256GcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextWithTag: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  checkKeyAndNonce(key, nonce);
  if (ciphertextWithTag.length < AES_256_GCM_TAG_BYTES) {
    throw new CempCryptoError(
      `aes256Gcm: ciphertext is ${ciphertextWithTag.length} bytes, ` +
        `shorter than the ${AES_256_GCM_TAG_BYTES}-byte tag`,
    );
  }
  try {
    return gcm(key, nonce, aad).decrypt(ciphertextWithTag);
  } catch (e) {
    // Tag mismatch or corrupted input. noble's error is a fixed string about
    // the authentication tag — it carries no plaintext — so it is safe to
    // forward as `cause` (AGENTS.md rule 2).
    throw new CempCryptoError("AES-256-GCM authentication failed", e);
  }
}
