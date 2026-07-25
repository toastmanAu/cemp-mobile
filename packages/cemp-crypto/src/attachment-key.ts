/**
 * Send-side attachment-key derivation (spec §9.2 + §6 coordination).
 *
 * Attachments are encrypted under a key derived from the SAME ML-KEM
 * encapsulation as the message envelope. The sender must know that key BEFORE
 * publishing chunks, so this helper re-runs the encapsulation with a caller-
 * supplied `kemMessage` (making it deterministic) and derives the attachment
 * key. The message envelope is later sealed with the same `kemMessage`+`nonce`,
 * so the receiver re-derives a byte-identical key on decrypt.
 *
 * SAFETY: `kemMessage`+`nonce` MUST be fresh CSPRNG per message and used for
 * exactly ONE published envelope. Reuse breaks per-envelope key uniqueness.
 */
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { AES_256_GCM_NONCE_BYTES } from "./aead.js";
import { CempCryptoError } from "./errors.js";
import { deriveMessageKey } from "./hkdf.js";
import { ML_KEM_768_SIZES } from "./identity.js";

export interface DeriveSendAttachmentKeyParams {
  readonly recipientKemPublicKey: Uint8Array;
  /** 32-byte FIPS-203 encapsulation message — fresh CSPRNG per message. */
  readonly kemMessage: Uint8Array;
  /** 12-byte envelope nonce — fresh CSPRNG per message. */
  readonly nonce: Uint8Array;
  readonly senderProfileId: Uint8Array;
  readonly recipientProfileId: Uint8Array;
}

function requireLength(label: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new CempCryptoError(`${label} is ${value.length} bytes, expected ${expected}`);
  }
}

export function deriveSendAttachmentKey(params: DeriveSendAttachmentKeyParams): Uint8Array {
  requireLength("recipientKemPublicKey", params.recipientKemPublicKey, ML_KEM_768_SIZES.publicKey);
  requireLength("kemMessage", params.kemMessage, ML_KEM_768_SIZES.sharedSecret);
  requireLength("nonce", params.nonce, AES_256_GCM_NONCE_BYTES);
  requireLength("senderProfileId", params.senderProfileId, 32);
  requireLength("recipientProfileId", params.recipientProfileId, 32);

  let sharedSecret: Uint8Array;
  try {
    ({ sharedSecret } = ml_kem768.encapsulate(params.recipientKemPublicKey, params.kemMessage));
  } catch (e) {
    throw new CempCryptoError("ML-KEM-768 encapsulation failed", e);
  }
  try {
    return deriveMessageKey(
      sharedSecret,
      params.nonce,
      params.senderProfileId,
      params.recipientProfileId,
      "CEMP-ATTACHMENT-KEY-V1",
    );
  } finally {
    sharedSecret.fill(0);
  }
}
