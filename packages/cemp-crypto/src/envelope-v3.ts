/**
 * CEMP protocol version 3 envelopes (ADR 0007): sign, then encrypt.
 *
 *   seal: ml_kem768.encapsulate(recipient_kem_pk)        → (kem_ct, ss)
 *         transcript = molecule(CempSigningTranscriptV3{header, kem_ct, nonce,
 *                       sender_id, conversation_id, content_type,
 *                       created_at_client, payload})
 *         signature  = ML-DSA-65.Sign(sk, transcript, ctx = "CEMP-ENVELOPE-V3")
 *         inner      = molecule(CempInnerV3{…, sig_algorithm, signature})
 *         key        = HKDF(salt = nonce, IKM = ss, "CEMP-MESSAGE-KEY-V3" ‖ recipient_id)
 *         envelope   = molecule(CempEnvelopeV3{header, kem_ct, nonce,
 *                       AES-256-GCM(key, nonce, inner, AAD = molecule(header))})
 *
 * The signature travels INSIDE the ciphertext, so only the recipient can see
 * or check it (ADR 0007 §1). Signing is FIPS 204 pure mode over the whole
 * transcript, no prehash; the context separates it from the CKB lock
 * signatures made with the same key (`mldsa-v2.ts`, ctx "CKB-MLDSA-LOCK"),
 * which this module does not touch.
 *
 * `openEnvelopeV3` decrypts and runs every check that needs no sender key
 * (strict decode, algorithm id, recipient and conversation binding). It does
 * NOT decide who the sender is: the caller resolves the sender's key and
 * calls {@link verifyEnvelopeV3} on the returned transcript (in @cemp/ckb,
 * `AuthenticatedSenderResolver`). Every failure surfaces as
 * {@link CempCryptoError}; no partial plaintext is ever returned.
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { codec, deriveConversationId, ENVELOPE_SIGNATURE_CONTEXT_V3 } from "@cemp/core";
import { AES_256_GCM_NONCE_BYTES, aes256GcmDecrypt, aes256GcmEncrypt } from "./aead.js";
import { MESSAGE_KEY_DOMAIN_V3 } from "./domains.js";
import { CempCryptoError } from "./errors.js";
import { deriveMessageKeyV3 } from "./hkdf.js";
import { ML_KEM_768_SIZES } from "./identity.js";
import { MLDSA_V2_SIZES } from "./mldsa-v2.js";
import { randomBytes } from "./random.js";

/** ML-DSA context of the envelope signature (ADR 0007 §3). */
export const ENVELOPE_V3_CONTEXT = ENVELOPE_SIGNATURE_CONTEXT_V3;
const CONTEXT_BYTES = new TextEncoder().encode(ENVELOPE_V3_CONTEXT);

const PROFILE_ID_BYTES = 32;

function requireLength(label: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new CempCryptoError(`${label} is ${value.length} bytes, expected ${expected}`);
  }
}

/* ── signature ──────────────────────────────────────────────────────────── */

/**
 * ML-DSA-65 pure-mode signature over the transcript bytes with ctx
 * "CEMP-ENVELOPE-V3". Hedged (randomized) unless `extraEntropy` is given;
 * vectors pass 32 zero bytes for byte-exact known answers.
 */
export function signEnvelopeV3(
  secretKey: Uint8Array,
  transcript: Uint8Array,
  extraEntropy?: Uint8Array,
): Uint8Array {
  requireLength("signEnvelopeV3 secretKey", secretKey, MLDSA_V2_SIZES.sk);
  if (extraEntropy !== undefined) {
    requireLength("signEnvelopeV3 extraEntropy", extraEntropy, 32);
  }
  try {
    return ml_dsa65.sign(transcript, secretKey, {
      context: CONTEXT_BYTES,
      ...(extraEntropy === undefined ? {} : { extraEntropy }),
    });
  } catch (e) {
    throw new CempCryptoError("ML-DSA-65 envelope signing failed", e);
  }
}

function isBytes(value: unknown, length?: number): value is Uint8Array {
  return value instanceof Uint8Array && (length === undefined || value.length === length);
}

/**
 * Verify an envelope signature. TOTAL at the trust boundary: wrong lengths,
 * non-byte inputs and malformed keys or signatures return false, never throw.
 */
export function verifyEnvelopeV3(
  publicKey: Uint8Array,
  transcript: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (
    !isBytes(publicKey, MLDSA_V2_SIZES.pk) ||
    !isBytes(signature, MLDSA_V2_SIZES.sig) ||
    !isBytes(transcript)
  ) {
    return false;
  }
  try {
    return ml_dsa65.verify(signature, transcript, publicKey, { context: CONTEXT_BYTES }) === true;
  } catch {
    return false;
  }
}

/* ── seal ───────────────────────────────────────────────────────────────── */

export interface SealEnvelopeV3Params {
  /** Clear header; its Molecule encoding is the AEAD AAD and in the transcript. */
  readonly header: codec.CempEnvelopeHeaderV3Encodable;
  /** The ACTIVE local profile id (never caller-chosen identity, ADR 0007 §7). */
  readonly senderProfileId: Uint8Array;
  readonly contentType: number;
  readonly createdAtClient: bigint;
  /** Payload (unchanged v2 layout); its recipient_profile_id names the recipient. */
  readonly payload: codec.CempPayloadV2Encodable;
  readonly recipientKemPublicKey: Uint8Array;
  /** The active local profile's ML-DSA-65 secret key (4032 bytes). */
  readonly signerSecretKey: Uint8Array;
  /**
   * The active profile's published ML-DSA-65 public key. The fresh signature
   * is verified against it before anything is returned, so a signer key that
   * does not match the published profile can never produce a sendable
   * envelope (the recipient would reject it anyway).
   */
  readonly signerPublicKey: Uint8Array;
  /** Test/vector seam or the image path's §6 coordination (fresh per message). */
  readonly nonce?: Uint8Array;
  readonly kemMessage?: Uint8Array;
  /** 32 zero bytes for deterministic vectors; omit for hedged signing. */
  readonly extraEntropy?: Uint8Array;
}

export interface SealEnvelopeV3Result {
  /** Serialized `CempEnvelopeV3` — the message-cell data. */
  readonly envelopeBytes: Uint8Array;
  readonly kemCiphertext: Uint8Array;
  readonly nonce: Uint8Array;
  /** molecule(CempSigningTranscriptV3) — what was signed (never on the wire). */
  readonly transcript: Uint8Array;
  readonly signature: Uint8Array;
  /** SECRET (caller wipes). */
  readonly attachmentKey: Uint8Array;
  /** SECRET (caller stores on the outgoing row, then wipes). */
  readonly receiptKey: Uint8Array;
}

/** Inputs of the low-level sealer (vector / negative-test seam). */
export interface SealInnerV3RawParams {
  readonly header: codec.CempEnvelopeHeaderV3Encodable;
  readonly recipientKemPublicKey: Uint8Array;
  /** Recipient id in the KEY SCHEDULE (production: the payload's recipient). */
  readonly kdfRecipientProfileId: Uint8Array;
  readonly nonce?: Uint8Array;
  readonly kemMessage?: Uint8Array;
  /** Builds the inner plaintext once the KEM ciphertext is known. */
  readonly buildInner: (kemCiphertext: Uint8Array, nonce: Uint8Array) => Uint8Array;
}

interface SealedRaw {
  readonly envelopeBytes: Uint8Array;
  readonly kemCiphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly attachmentKey: Uint8Array;
  readonly receiptKey: Uint8Array;
}

/**
 * Low-level v3 sealer: encapsulate, let the caller build the inner plaintext
 * around the KEM ciphertext, encrypt. Performs NO inner validation and NO
 * signing — production code uses {@link sealEnvelopeV3}. Exposed so golden
 * and negative vectors can carry deliberately malformed inner plaintexts
 * (anyone holding the recipient's PUBLIC key can build these anyway).
 */
export function sealInnerV3Raw(params: SealInnerV3RawParams): SealedRaw {
  requireLength("recipientKemPublicKey", params.recipientKemPublicKey, ML_KEM_768_SIZES.publicKey);
  requireLength("kdfRecipientProfileId", params.kdfRecipientProfileId, PROFILE_ID_BYTES);
  if (params.header.protocol_version !== 3) {
    throw new CempCryptoError(
      `sealEnvelopeV3: header protocol_version ${String(params.header.protocol_version)} is not 3`,
    );
  }
  const nonce = params.nonce ?? randomBytes(AES_256_GCM_NONCE_BYTES);
  requireLength("nonce", nonce, AES_256_GCM_NONCE_BYTES);
  if (params.kemMessage !== undefined) {
    requireLength("kemMessage", params.kemMessage, ML_KEM_768_SIZES.sharedSecret);
  }
  let cipherText: Uint8Array;
  let sharedSecret: Uint8Array;
  try {
    ({ cipherText, sharedSecret } = ml_kem768.encapsulate(
      params.recipientKemPublicKey,
      params.kemMessage,
    ));
  } catch (e) {
    throw new CempCryptoError("ML-KEM-768 encapsulation failed", e);
  }
  const recipient = params.kdfRecipientProfileId;
  const messageKey = deriveMessageKeyV3(
    sharedSecret,
    nonce,
    recipient,
    MESSAGE_KEY_DOMAIN_V3.MessageKey,
  );
  try {
    const innerBytes = params.buildInner(cipherText, nonce);
    const aad = codec.encodeCempEnvelopeHeaderV3(params.header);
    const encryptedPayload = aes256GcmEncrypt(messageKey, nonce, innerBytes, aad);
    const envelopeBytes = codec.encodeCempEnvelopeV3({
      header: params.header,
      kem_ciphertext: cipherText,
      nonce,
      encrypted_payload: encryptedPayload,
    });
    const attachmentKey = deriveMessageKeyV3(
      sharedSecret,
      nonce,
      recipient,
      MESSAGE_KEY_DOMAIN_V3.AttachmentKey,
    );
    const receiptKey = deriveMessageKeyV3(
      sharedSecret,
      nonce,
      recipient,
      MESSAGE_KEY_DOMAIN_V3.ReceiptKey,
    );
    return { envelopeBytes, kemCiphertext: cipherText, nonce, attachmentKey, receiptKey };
  } finally {
    messageKey.fill(0);
    sharedSecret.fill(0);
  }
}

/**
 * Sign and encrypt one v3 message (ADR 0007 §3, §7). The signature is made
 * before anything is returned and self-verified against `signerPublicKey`;
 * the inner plaintext is checked with the receiver's own key-free checks
 * first, so a sender-side bug fails here rather than at the recipient.
 */
export function sealEnvelopeV3(params: SealEnvelopeV3Params): SealEnvelopeV3Result {
  requireLength("senderProfileId", params.senderProfileId, PROFILE_ID_BYTES);
  requireLength("signerPublicKey", params.signerPublicKey, MLDSA_V2_SIZES.pk);
  let payload: codec.CempPayloadV2;
  try {
    payload = codec.decodeCempPayloadV2(codec.encodeCempPayloadV2(params.payload));
  } catch (e) {
    throw new CempCryptoError("sealEnvelopeV3: payload is not a valid CempPayloadV2", e);
  }
  const recipientProfileId = payload.recipient_profile_id;
  const conversationId = deriveConversationId(params.senderProfileId, recipientProfileId);
  let transcript: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  const sealed = sealInnerV3Raw({
    header: params.header,
    recipientKemPublicKey: params.recipientKemPublicKey,
    kdfRecipientProfileId: recipientProfileId,
    ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
    ...(params.kemMessage === undefined ? {} : { kemMessage: params.kemMessage }),
    buildInner: (kemCiphertext, nonce) => {
      const unsigned = {
        sender_profile_id: params.senderProfileId,
        conversation_id: conversationId,
        content_type: params.contentType,
        created_at_client: params.createdAtClient,
        payload,
      };
      // The receiver's key-free checks, on the inner we are about to sign.
      const provisional = {
        ...unsigned,
        sig_algorithm: codec.ALGORITHM_ID_BYTES.MlDsa65,
        signature: new Uint8Array(MLDSA_V2_SIZES.sig),
      };
      const check = codec.validateInnerV3Fields(provisional, recipientProfileId);
      if (!check.ok) {
        throw new CempCryptoError(`sealEnvelopeV3: inner would be rejected: ${check.reason}`);
      }
      transcript = codec.signingTranscriptV3(
        { header: params.header, kem_ciphertext: kemCiphertext, nonce },
        unsigned,
      );
      signature = signEnvelopeV3(params.signerSecretKey, transcript, params.extraEntropy);
      if (!verifyEnvelopeV3(params.signerPublicKey, transcript, signature)) {
        throw new CempCryptoError(
          "sealEnvelopeV3: signer secret key does not match the active profile's public key",
        );
      }
      return codec.encodeCempInnerV3({ ...provisional, signature });
    },
  });
  if (transcript === undefined || signature === undefined) {
    throw new CempCryptoError("sealEnvelopeV3: internal: inner was not built");
  }
  // Sender-side gate: the recipient's pre-decrypt validation must pass.
  const check = codec.validateEnvelope(sealed.envelopeBytes);
  if (!check.ok) {
    throw new CempCryptoError(`sealEnvelopeV3 produced an invalid envelope: ${check.reason}`);
  }
  return { ...sealed, transcript, signature };
}

/* ── open ───────────────────────────────────────────────────────────────── */

export interface OpenEnvelopeV3Params {
  readonly envelopeBytes: Uint8Array;
  readonly recipientKemSecretKey: Uint8Array;
  readonly ownProfileId: Uint8Array;
}

/**
 * A decrypted v3 message whose key-free checks passed and whose signature is
 * NOT yet verified. Its sender id is a CLAIM until a verifier checks
 * `inner.signature` over `transcript` with a resolved key.
 */
export interface OpenedEnvelopeV3 {
  readonly header: codec.CempEnvelopeHeaderV3;
  readonly inner: codec.CempInnerV3;
  /** molecule(CempSigningTranscriptV3), rebuilt from the wire. */
  readonly transcript: Uint8Array;
  /** SECRET (caller wipes). */
  readonly attachmentKey: Uint8Array;
  /** SECRET (caller wipes). */
  readonly receiptKey: Uint8Array;
}

/**
 * Validate, decapsulate, decrypt and strict-decode a v3 envelope (ADR 0007
 * §6, up to "recipient_profile_id == me"). Throws {@link CempCryptoError} on
 * any failure; never returns partial plaintext.
 */
export function openEnvelopeV3(params: OpenEnvelopeV3Params): OpenedEnvelopeV3 {
  const validation = codec.validateEnvelope(params.envelopeBytes);
  if (!validation.ok) {
    throw new CempCryptoError(`envelope rejected by pre-decrypt validation: ${validation.reason}`);
  }
  const decoded = codec.decodeCempEnvelope(params.envelopeBytes);
  if (decoded.version !== 3) {
    throw new CempCryptoError(
      `openEnvelopeV3 handles protocol_version 3 only; got protocol_version ${String(decoded.version)}`,
    );
  }
  const envelope = decoded.envelope;
  requireLength("recipientKemSecretKey", params.recipientKemSecretKey, ML_KEM_768_SIZES.secretKey);
  requireLength("ownProfileId", params.ownProfileId, PROFILE_ID_BYTES);

  let sharedSecret: Uint8Array;
  try {
    sharedSecret = ml_kem768.decapsulate(envelope.kem_ciphertext, params.recipientKemSecretKey);
  } catch (e) {
    throw new CempCryptoError("ML-KEM-768 decapsulation failed", e);
  }
  const me = params.ownProfileId;
  const messageKey = deriveMessageKeyV3(
    sharedSecret,
    envelope.nonce,
    me,
    MESSAGE_KEY_DOMAIN_V3.MessageKey,
  );
  try {
    const aad = codec.encodeCempEnvelopeHeaderV3(envelope.header);
    const innerBytes = aes256GcmDecrypt(
      messageKey,
      envelope.nonce,
      envelope.encrypted_payload,
      aad,
    );
    const innerCheck = codec.validateInnerV3(innerBytes, me);
    if (!innerCheck.ok) {
      throw new CempCryptoError(`v3 inner plaintext rejected: ${innerCheck.reason}`);
    }
    const inner = codec.decodeCempInnerV3(innerBytes);
    const transcript = codec.signingTranscriptV3(envelope, inner);
    const attachmentKey = deriveMessageKeyV3(
      sharedSecret,
      envelope.nonce,
      me,
      MESSAGE_KEY_DOMAIN_V3.AttachmentKey,
    );
    const receiptKey = deriveMessageKeyV3(
      sharedSecret,
      envelope.nonce,
      me,
      MESSAGE_KEY_DOMAIN_V3.ReceiptKey,
    );
    return { header: envelope.header, inner, transcript, attachmentKey, receiptKey };
  } finally {
    messageKey.fill(0);
    sharedSecret.fill(0);
  }
}
