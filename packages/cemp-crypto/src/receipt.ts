/**
 * Receipt proof of decryption (ADR 0006, protocol version 2).
 *
 * Only the two parties who can decrypt message M (its sender and its intended
 * recipient) can derive M's receipt key from the ML-KEM shared secret:
 *
 *   PRK         = HKDF-Extract(salt = envelope_nonce, IKM = ml_kem_shared_secret)
 *   receipt_key = HKDF-Expand(PRK, "CEMP-RECEIPT-KEY-V1" ‖ sender_id ‖ recipient_id, 32)
 *   proof       = HMAC-SHA256(receipt_key, "CEMP-RECEIPT-PROOF-V1" ‖ message_id[16] ‖ status[1])
 *
 * A receipt carrying a valid proof therefore came from someone who could
 * decrypt M. All MAC inputs are fixed length, so the concatenation is
 * unambiguous; the status and the message id are inside the MAC, so a proof
 * can be neither relabelled (0x01 → 0x05) nor moved to another message.
 *
 * The receipt key is SECRET: it lives only in the encrypted database and in
 * short-lived memory, never on the wire and never in logs (AGENTS.md rule 2).
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { MESSAGE_KEY_DOMAIN, RECEIPT_PROOF_DOMAIN } from "./domains.js";
import { CempCryptoError } from "./errors.js";
import { deriveMessageKey } from "./hkdf.js";

export const RECEIPT_KEY_BYTES = 32;
export const RECEIPT_PROOF_BYTES = 32;
const MESSAGE_ID_BYTES = 16;

const PROOF_DOMAIN_BYTES = new TextEncoder().encode(RECEIPT_PROOF_DOMAIN);

/** Derive the per-message receipt key (ADR 0006) from the envelope's KEM secret. */
export function deriveReceiptKey(
  mlKemSharedSecret: Uint8Array,
  envelopeNonce: Uint8Array,
  senderProfileId: Uint8Array,
  recipientProfileId: Uint8Array,
): Uint8Array {
  return deriveMessageKey(
    mlKemSharedSecret,
    envelopeNonce,
    senderProfileId,
    recipientProfileId,
    MESSAGE_KEY_DOMAIN.ReceiptKey,
  );
}

function isStatusByte(status: number): boolean {
  return Number.isInteger(status) && status >= 0 && status <= 0xff;
}

function proofInput(messageId: Uint8Array, status: number): Uint8Array {
  const input = new Uint8Array(PROOF_DOMAIN_BYTES.length + MESSAGE_ID_BYTES + 1);
  input.set(PROOF_DOMAIN_BYTES, 0);
  input.set(messageId, PROOF_DOMAIN_BYTES.length);
  input[PROOF_DOMAIN_BYTES.length + MESSAGE_ID_BYTES] = status;
  return input;
}

/** The 32-byte proof for one receipt entry. Throws on malformed local inputs. */
export function computeReceiptProof(
  receiptKey: Uint8Array,
  messageId: Uint8Array,
  status: number,
): Uint8Array {
  if (receiptKey.length !== RECEIPT_KEY_BYTES) {
    throw new CempCryptoError(
      `receiptKey is ${receiptKey.length} bytes, expected ${RECEIPT_KEY_BYTES}`,
    );
  }
  if (messageId.length !== MESSAGE_ID_BYTES) {
    throw new CempCryptoError(
      `messageId is ${messageId.length} bytes, expected ${MESSAGE_ID_BYTES}`,
    );
  }
  if (!isStatusByte(status)) {
    throw new CempCryptoError(`receipt status ${String(status)} is not a byte`);
  }
  return hmac(sha256, receiptKey, proofInput(messageId, status));
}

/** Length-checked, data-independent-time byte comparison. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Verify a received proof in constant time (ADR 0006 acceptance rule 4).
 * Total: hostile or malformed input returns false, never throws.
 */
export function verifyReceiptProof(
  receiptKey: Uint8Array,
  messageId: Uint8Array,
  status: number,
  proof: Uint8Array,
): boolean {
  if (
    receiptKey.length !== RECEIPT_KEY_BYTES ||
    messageId.length !== MESSAGE_ID_BYTES ||
    proof.length !== RECEIPT_PROOF_BYTES ||
    !isStatusByte(status)
  ) {
    return false;
  }
  const expected = computeReceiptProof(receiptKey, messageId, status);
  try {
    return constantTimeEqual(expected, proof);
  } finally {
    expected.fill(0);
  }
}
