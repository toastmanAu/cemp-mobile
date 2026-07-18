/**
 * CEMP v1 envelope encryption (spec §7–§8):
 *
 *   encrypt: ml_kem768.encapsulate(recipient_kem_pk) → (kem_ct, shared_secret)
 *            message_key = HKDF(salt = nonce, IKM = shared_secret,
 *                               "CEMP-MESSAGE-KEY-V1" ‖ sender_id ‖ recipient_id)
 *            aad = molecule(CempEnvelopeHeaderV1)
 *            encrypted_payload = AES-256-GCM(message_key, nonce, payload, aad)
 *            envelope = molecule(CempEnvelopeV1)
 *
 * The AEAD AAD is exactly the Molecule encoding of the header (spec §7), so
 * the codec from @cemp/core is part of the cryptographic contract. The
 * recipient profile id is NOT in the clear header (spec §7): the encrypt side
 * recovers it by decoding the payload, the decrypt side substitutes its own
 * profile id — a mismatch makes the message key differ and the AEAD tag fail,
 * which is the cryptographic half of the recipient binding (spec §12.5's
 * semantic check is the other half and runs after decryption, in the caller).
 *
 * Processing order on decrypt (spec §7.2/§12): `codec.validateEnvelope`
 * (shape, version, §11 limits) runs BEFORE any decapsulation; only then
 * ML-KEM decapsulation and AEAD. Every failure surfaces as
 * {@link CempCryptoError}; no partial plaintext is ever returned.
 */

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { codec } from "@cemp/core";
import { AES_256_GCM_NONCE_BYTES, aes256GcmDecrypt, aes256GcmEncrypt } from "./aead.js";
import { CempCryptoError } from "./errors.js";
import { deriveMessageKey } from "./hkdf.js";
import { ML_KEM_768_SIZES } from "./identity.js";
import { randomBytes } from "./random.js";

/** Profile-id width, fixed by the wire types (spec §2). */
const PROFILE_ID_BYTES = 32;

/** Inputs every production caller supplies. */
export interface EncryptEnvelopeParams {
  /** Already Molecule-encoded `CempPayloadV1` (spec §8); padding included. */
  readonly payload: Uint8Array;
  /** Recipient's ML-KEM-768 public key (1184 bytes, from their profile cell). */
  readonly recipientKemPublicKey: Uint8Array;
  /** Clear envelope header; its Molecule encoding is the AEAD AAD (spec §7). */
  readonly header: codec.CempEnvelopeHeaderV1Encodable;
}

/**
 * Golden-vector / test-only overrides (spec §14). Production callers MUST NOT
 * pass these: envelope nonces and encapsulation randomness must come from the
 * OS CSPRNG, because reusing them breaks per-envelope key uniqueness
 * (spec §7 "Nonce reuse").
 */
export interface EncryptEnvelopeTestOverrides {
  /** Fixed 12-byte envelope nonce (otherwise `crypto.getRandomValues`). */
  readonly nonce?: Uint8Array;
  /** Fixed 32-byte FIPS-203 encapsulation message (otherwise random). */
  readonly kemMessage?: Uint8Array;
}

export interface EncryptEnvelopeResult {
  /** Serialized `CempEnvelopeV1` — the message-cell data (spec §6). */
  readonly envelopeBytes: Uint8Array;
  /** ML-KEM-768 ciphertext (1088 bytes), also inside `envelopeBytes`. */
  readonly kemCiphertext: Uint8Array;
  /** Envelope nonce actually used (12 bytes; random unless overridden). */
  readonly nonce: Uint8Array;
  /**
   * The 32-byte attachment key for this envelope (spec §9.2): derived from
   * the same KEM shared secret under the `CEMP-ATTACHMENT-KEY-V1` domain, so
   * attachments are encrypted WITHOUT transporting any key — the recipient
   * re-derives it on decrypt. SECRET: caller owns and wipes it.
   */
  readonly attachmentKey: Uint8Array;
}

export interface DecryptEnvelopeParams {
  /** Serialized `CempEnvelopeV1` as read from the message cell. */
  readonly envelopeBytes: Uint8Array;
  /** Own ML-KEM-768 secret key (2400 bytes). */
  readonly recipientKemSecretKey: Uint8Array;
  /** Own profile id (32 bytes); bound into the message key (spec §3). */
  readonly ownProfileId: Uint8Array;
}

export interface DecryptEnvelopeResult {
  /** Decoded clear header (already shape- and limit-validated, spec §12.1–3). */
  readonly header: codec.CempEnvelopeHeaderV1;
  /**
   * Decrypted payload plaintext: the Molecule-encoded `CempPayloadV1`. The
   * caller MUST continue the spec §12 pipeline (strict payload decode,
   * `validatePayload`, `validateSemanticConsistency`) before using it.
   */
  readonly payloadBytes: Uint8Array;
  /**
   * The 32-byte attachment key (spec §9.2), re-derived from the decapsulated
   * shared secret under `CEMP-ATTACHMENT-KEY-V1`. SECRET: caller owns and
   * wipes it. Present for parity with {@link EncryptEnvelopeResult} — the two
   * sides derive byte-identical keys.
   */
  readonly attachmentKey: Uint8Array;
}

function requireLength(label: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new CempCryptoError(`${label} is ${value.length} bytes, expected ${expected}`);
  }
}

/**
 * Encrypt an encoded payload into a serialized `CempEnvelopeV1` (spec §7).
 * The header is cross-checked against the payload (message id, body type)
 * before any encryption so sender-side bugs fail before publishing.
 */
export function encryptEnvelope(
  params: EncryptEnvelopeParams & EncryptEnvelopeTestOverrides,
): EncryptEnvelopeResult {
  const { payload, recipientKemPublicKey, header } = params;
  requireLength("recipientKemPublicKey", recipientKemPublicKey, ML_KEM_768_SIZES.publicKey);

  const nonce = params.nonce ?? randomBytes(AES_256_GCM_NONCE_BYTES);
  requireLength("nonce", nonce, AES_256_GCM_NONCE_BYTES);
  if (params.kemMessage !== undefined) {
    requireLength("kemMessage", params.kemMessage, ML_KEM_768_SIZES.sharedSecret);
  }

  // The recipient profile id lives inside the encrypted payload (spec §7), so
  // it is recovered by decoding the payload. This doubles as a sender-side
  // canonicality and header/payload consistency check.
  let decodedPayload: codec.CempPayloadV1;
  try {
    decodedPayload = codec.decodeCempPayloadV1(payload);
  } catch (e) {
    throw new CempCryptoError(
      "encryptEnvelope: payload is not a canonical CempPayloadV1 encoding",
      e,
    );
  }
  if (!codec.bytesEqual(decodedPayload.message_id, header.message_id)) {
    throw new CempCryptoError(
      "encryptEnvelope: payload message_id does not match header message_id",
    );
  }
  if (decodedPayload.body_type !== header.content_type) {
    throw new CempCryptoError(
      "encryptEnvelope: payload body_type does not match header content_type",
    );
  }

  let cipherText: Uint8Array;
  let sharedSecret: Uint8Array;
  try {
    ({ cipherText, sharedSecret } = ml_kem768.encapsulate(
      recipientKemPublicKey,
      params.kemMessage,
    ));
  } catch (e) {
    throw new CempCryptoError("ML-KEM-768 encapsulation failed", e);
  }
  requireLength("internal kemCiphertext", cipherText, ML_KEM_768_SIZES.ciphertext);

  const messageKey = deriveMessageKey(
    sharedSecret,
    nonce,
    header.sender_profile_id,
    decodedPayload.recipient_profile_id,
  );
  let encryptedPayload: Uint8Array;
  let attachmentKey: Uint8Array;
  try {
    const aad = codec.encodeCempEnvelopeHeaderV1(header);
    encryptedPayload = aes256GcmEncrypt(messageKey, nonce, payload, aad);
    // The attachment key uses the SAME shared secret under its own domain
    // (spec §9.2) — no key material is ever transported.
    attachmentKey = deriveMessageKey(
      sharedSecret,
      nonce,
      header.sender_profile_id,
      decodedPayload.recipient_profile_id,
      "CEMP-ATTACHMENT-KEY-V1",
    );
  } finally {
    // Best-effort wipe of per-envelope secrets (see identity.ts for the
    // JavaScript zeroisation limits).
    messageKey.fill(0);
    sharedSecret.fill(0);
  }

  const envelopeBytes = codec.encodeCempEnvelopeV1({
    header,
    kem_ciphertext: cipherText,
    nonce,
    encrypted_payload: encryptedPayload,
  });
  // Sender-side gate: a publishable envelope must pass the same pre-decrypt
  // validation the recipient will run (spec §7.2/§11).
  const check = codec.validateEnvelope(envelopeBytes);
  if (!check.ok) {
    throw new CempCryptoError(`encryptEnvelope produced an invalid envelope: ${check.reason}`);
  }
  return { envelopeBytes, kemCiphertext: cipherText, nonce, attachmentKey };
}

/**
 * Validate and decrypt a serialized `CempEnvelopeV1` (spec §7.2, §12).
 * Validation (shape → version → §11 limits) runs before decapsulation; ML-KEM
 * implicit rejection and every AEAD failure surface as {@link CempCryptoError}
 * with no partial plaintext.
 */
export function decryptEnvelope(params: DecryptEnvelopeParams): DecryptEnvelopeResult {
  const { envelopeBytes, recipientKemSecretKey, ownProfileId } = params;

  // spec §7.2: limits and shape checks BEFORE any decapsulation.
  const validation = codec.validateEnvelope(envelopeBytes);
  if (!validation.ok) {
    throw new CempCryptoError(`envelope rejected by pre-decrypt validation: ${validation.reason}`);
  }
  // Cannot fail after validateEnvelope passed (it strict-decoded the same
  // bytes); decoded again here simply because validateEnvelope is key-free
  // and returns no value.
  const envelope = codec.decodeCempEnvelopeV1(envelopeBytes);

  requireLength("recipientKemSecretKey", recipientKemSecretKey, ML_KEM_768_SIZES.secretKey);
  requireLength("ownProfileId", ownProfileId, PROFILE_ID_BYTES);

  let sharedSecret: Uint8Array;
  try {
    // FIPS-203 implicit rejection: a tampered ciphertext yields a bogus
    // shared secret instead of an error, so the AEAD check below is the
    // actual rejection point (spec §12.4).
    sharedSecret = ml_kem768.decapsulate(envelope.kem_ciphertext, recipientKemSecretKey);
  } catch (e) {
    throw new CempCryptoError("ML-KEM-768 decapsulation failed", e);
  }
  const messageKey = deriveMessageKey(
    sharedSecret,
    envelope.nonce,
    envelope.header.sender_profile_id,
    ownProfileId,
  );
  let attachmentKey: Uint8Array;
  try {
    const aad = codec.encodeCempEnvelopeHeaderV1(envelope.header);
    const payloadBytes = aes256GcmDecrypt(
      messageKey,
      envelope.nonce,
      envelope.encrypted_payload,
      aad,
    );
    // Same secret, attachment domain (spec §9.2) — byte-identical to the
    // sender's attachment key; derived only after the AEAD check passed.
    attachmentKey = deriveMessageKey(
      sharedSecret,
      envelope.nonce,
      envelope.header.sender_profile_id,
      ownProfileId,
      "CEMP-ATTACHMENT-KEY-V1",
    );
    return { header: envelope.header, payloadBytes, attachmentKey };
  } finally {
    messageKey.fill(0);
    sharedSecret.fill(0);
  }
}
