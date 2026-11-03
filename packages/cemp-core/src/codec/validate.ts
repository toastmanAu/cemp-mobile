/**
 * CEMP v1 malformed-input validation pipeline (spec §12, limits §11).
 *
 * Every function in this module is total: hostile input produces
 * `{ ok: false, reason }` — never a thrown exception, never a partial parse.
 * The processing order follows spec §12: shape (strict decode via
 * `./codecs.js`) → version/algorithms → limits → (crypto happens elsewhere)
 * → semantic consistency.
 *
 * Envelope validation is deliberately key-free (spec §7.2): all §11 limits
 * that gate decapsulation are checked here before any key material is
 * needed, so `validateEnvelope` MUST run before ML-KEM decapsulation is
 * attempted.
 */

import { CEMP_ENVELOPE_PROTOCOL_VERSIONS, CEMP_PROTOCOL_VERSION } from "../protocol.js";
import { CONTENT_TYPE } from "../envelope.js";
import { deriveConversationId } from "../identity.js";
import {
  bytesEqual,
  CempCodecError,
  decodeCempEnvelope,
  decodeCempInnerV3,
  decodeCempPayloadV1,
  decodeCempPayloadV2,
  decodeCempProfileV1,
  encodeCempPayloadV2,
  MLDSA65_SIGNATURE_BYTES,
  PAYLOAD_PROTOCOL_VERSION,
} from "./codecs.js";
import type {
  AlgorithmIdV1,
  CempEnvelopeHeaderV1,
  CempEnvelopeV1,
  CempEnvelopeV3,
  CempInnerV3,
  CempPayloadV1,
  CempPayloadV2,
  CempProfileV1,
} from "./codecs.js";

export type ValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: ValidationResult = { ok: true };

function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}

// ── hard limits (spec §11) ──────────────────────────────────────────────────

export const V1_LIMITS = {
  maxTextBytes: 16_384,
  maxPayloadBytes: 65_536,
  maxEnvelopeBytes: 82_000,
  maxHandleBytes: 64,
  maxProfileBytes: 4_096,
  maxPaddingBytes: 255,
  maxAttachmentManifests: 4,
  maxReceipts: 64,
  maxProtocolVersions: 8,
  /** AES-256-GCM tag appended to `encrypted_payload` (spec §7). */
  gcmTagBytes: 16,
} as const;

/**
 * Protocol version 2 limits (ADR 0006): identical to v1, plus the fixed
 * receipt-proof width.
 */
export const V2_LIMITS = {
  ...V1_LIMITS,
  receiptProofBytes: 32,
} as const;

/**
 * Protocol version 3 limits (ADR 0007). The payload limits are v2's; the
 * inner plaintext adds the 3,309-byte signature and the moved header fields,
 * so it may exceed the payload limit by a fixed 4 KiB allowance. The envelope
 * limit is unchanged (a maximum v3 envelope stays below 82,000 bytes).
 */
export const V3_LIMITS = {
  ...V2_LIMITS,
  signatureBytes: MLDSA65_SIGNATURE_BYTES,
  maxInnerBytes: V1_LIMITS.maxPayloadBytes + 4_096,
} as const;

// ── known identifier bytes (spec §3, §7) ────────────────────────────────────

/** `network` byte: 0x01 = ckb_testnet. */
export const NETWORK_CKB_TESTNET = 0x01;
/**
 * `network` byte 0x00 is reserved for mainnet (spec §7) and MUST be rejected
 * until the mainnet readiness gate passes (AGENTS.md rules 11–12).
 */
export const NETWORK_RESERVED_MAINNET = 0x00;

/** The only (family, parameter) pairs defined for v1 (spec §3). */
export const ALGORITHM_ID_BYTES = {
  MlDsa65: { family: 0x01, parameter: 61 },
  MlKem768: { family: 0x02, parameter: 3 },
  Aes256Gcm: { family: 0x03, parameter: 1 },
  HkdfSha256: { family: 0x04, parameter: 1 },
} as const;

function algorithmEquals(id: AlgorithmIdV1, known: { family: number; parameter: number }): boolean {
  return id.family === known.family && id.parameter === known.parameter;
}

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

function isKnownContentType(contentType: number): boolean {
  return (Object.values(CONTENT_TYPE) as number[]).includes(contentType);
}

// ── decode step (spec §12.1) ────────────────────────────────────────────────

function tryDecode<T>(
  structure: string,
  decode: (data: Uint8Array) => T,
  data: Uint8Array,
): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: decode(data) };
  } catch (e) {
    const detail = e instanceof CempCodecError ? e.message : errorMessage(e);
    return { ok: false, reason: `${structure} rejected: ${detail}` };
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── profile (spec §5, §12) ──────────────────────────────────────────────────

/** Field-level profile checks (spec §12.2–12.3) on an already-decoded profile. */
export function validateProfileFields(profile: CempProfileV1): ValidationResult {
  if (profile.protocol_version !== CEMP_PROTOCOL_VERSION) {
    return fail(
      `unknown protocol_version ${profile.protocol_version} (expected ${CEMP_PROTOCOL_VERSION})`,
    );
  }
  if (!algorithmEquals(profile.sig_algorithm, ALGORITHM_ID_BYTES.MlDsa65)) {
    return fail(
      `unknown sig_algorithm (family ${hexByte(profile.sig_algorithm.family)}, ` +
        `parameter ${profile.sig_algorithm.parameter})`,
    );
  }
  if (!algorithmEquals(profile.kem_algorithm, ALGORITHM_ID_BYTES.MlKem768)) {
    return fail(
      `unknown kem_algorithm (family ${hexByte(profile.kem_algorithm.family)}, ` +
        `parameter ${profile.kem_algorithm.parameter})`,
    );
  }
  if (profile.supported_protocol_versions.length > V1_LIMITS.maxProtocolVersions) {
    return fail(
      `supported_protocol_versions has ${profile.supported_protocol_versions.length} entries ` +
        `(max ${V1_LIMITS.maxProtocolVersions})`,
    );
  }
  if (!profile.supported_protocol_versions.includes(CEMP_PROTOCOL_VERSION)) {
    return fail(`supported_protocol_versions does not contain v${CEMP_PROTOCOL_VERSION}`);
  }
  if (profile.handle !== undefined && profile.handle.byteLength > V1_LIMITS.maxHandleBytes) {
    return fail(`handle is ${profile.handle.byteLength} bytes (max ${V1_LIMITS.maxHandleBytes})`);
  }
  // Review C1: revoked is 0x00|0x01; supported_attachments is a 2-bit mask.
  if (profile.revoked !== 0x00 && profile.revoked !== 0x01) {
    return fail(`unknown revoked value ${hexByte(profile.revoked)} (spec §5.3)`);
  }
  if (profile.supported_attachments > 0x03) {
    return fail(
      `supported_attachments ${hexByte(profile.supported_attachments)} is not a valid bitmask`,
    );
  }
  return OK;
}

/** Full profile pipeline: size gate → strict decode → field checks. */
export function validateProfile(data: Uint8Array): ValidationResult {
  try {
    // Cheap pre-decode gate for the §11 total-size limit (spec §12.3).
    if (data.byteLength > V1_LIMITS.maxProfileBytes) {
      return fail(
        `profile data is ${data.byteLength} bytes, exceeds the ` +
          `${V1_LIMITS.maxProfileBytes}-byte limit (spec §11)`,
      );
    }
    const decoded = tryDecode("CempProfileV1", decodeCempProfileV1, data);
    if (!decoded.ok) return decoded;
    return validateProfileFields(decoded.value);
  } catch (e) {
    return fail(`profile validation error: ${errorMessage(e)}`);
  }
}

// ── envelope (spec §7, §12) ─────────────────────────────────────────────────

/** Network-byte check shared by every envelope version (spec §7). */
function validateNetwork(network: number): ValidationResult {
  if (network !== NETWORK_CKB_TESTNET) {
    if (network === NETWORK_RESERVED_MAINNET) {
      return fail("network 0x00 is reserved for mainnet and not enabled (AGENTS.md rule 12)");
    }
    return fail(`unknown network byte ${hexByte(network)}`);
  }
  return OK;
}

/** Fixed-width and GCM-tag checks shared by every envelope version. */
function validateCiphertextFields(
  envelope: Pick<CempEnvelopeV1, "kem_ciphertext" | "nonce" | "encrypted_payload">,
): ValidationResult {
  // Guaranteed by the fixed Molecule arrays; asserted anyway (defense in depth).
  if (envelope.kem_ciphertext.byteLength !== 1088) {
    return fail(
      `internal: kem_ciphertext is ${envelope.kem_ciphertext.byteLength} bytes, expected 1088`,
    );
  }
  if (envelope.nonce.byteLength !== 12) {
    return fail(`internal: nonce is ${envelope.nonce.byteLength} bytes, expected 12`);
  }
  if (envelope.encrypted_payload.byteLength < V1_LIMITS.gcmTagBytes) {
    return fail(
      `encrypted_payload is ${envelope.encrypted_payload.byteLength} bytes, ` +
        `shorter than the ${V1_LIMITS.gcmTagBytes}-byte GCM tag`,
    );
  }
  return OK;
}

/**
 * Field-level envelope checks on an already-decoded v1/v2 envelope. Key-free
 * by design (spec §7.2): every check here runs before decapsulation.
 */
export function validateEnvelopeFields(envelope: CempEnvelopeV1): ValidationResult {
  const { header } = envelope;
  // ADR 0006: the header version selects the payload layout; this layout is
  // used by versions 1 and 2 only.
  if (header.protocol_version !== 1 && header.protocol_version !== 2) {
    return fail(
      `unknown protocol_version ${header.protocol_version} for the v1 envelope layout ` +
        `(expected one of ${CEMP_ENVELOPE_PROTOCOL_VERSIONS.join(", ")})`,
    );
  }
  const network = validateNetwork(header.network);
  if (!network.ok) return network;
  if (!isKnownContentType(header.content_type)) {
    return fail(`unknown content_type ${hexByte(header.content_type)}`);
  }
  return validateCiphertextFields(envelope);
}

/** Field-level checks on a decoded v3 envelope (ADR 0007). Key-free. */
export function validateEnvelopeV3Fields(envelope: CempEnvelopeV3): ValidationResult {
  if (envelope.header.protocol_version !== 3) {
    return fail(`unknown protocol_version ${envelope.header.protocol_version} for the v3 layout`);
  }
  const network = validateNetwork(envelope.header.network);
  if (!network.ok) return network;
  return validateCiphertextFields(envelope);
}

/**
 * Full envelope pipeline: hard size pre-check (≤ 82,000 B, spec §11) BEFORE
 * decoding, then the version byte (ADR 0007 §4) selects exactly one strict
 * schema, then field checks. Requires no keys, so it can — and must — run
 * before any decapsulation attempt (spec §7.2).
 */
export function validateEnvelope(data: Uint8Array): ValidationResult {
  try {
    if (data.byteLength > V1_LIMITS.maxEnvelopeBytes) {
      return fail(
        `envelope data is ${data.byteLength} bytes, exceeds the ` +
          `${V1_LIMITS.maxEnvelopeBytes}-byte limit (spec §11)`,
      );
    }
    const decoded = tryDecode("CempEnvelope", decodeCempEnvelope, data);
    if (!decoded.ok) return decoded;
    if (!CEMP_ENVELOPE_PROTOCOL_VERSIONS.includes(decoded.value.version)) {
      return fail(`protocol_version ${decoded.value.version} is not accepted by this build`);
    }
    return decoded.value.version === 3
      ? validateEnvelopeV3Fields(decoded.value.envelope)
      : validateEnvelopeFields(decoded.value.envelope);
  } catch (e) {
    return fail(`envelope validation error: ${errorMessage(e)}`);
  }
}

// ── payload (spec §8, §11, §12) ─────────────────────────────────────────────

/**
 * Field-level payload checks (spec §11, §12.3). `totalBytes` is the Molecule
 * serialization size when known (the §11 total-payload limit); pass `undefined`
 * to skip that single check when only the decoded value is at hand.
 */
export function validatePayloadFields(
  payload: CempPayloadV1 | CempPayloadV2,
  totalBytes: number | undefined,
): ValidationResult {
  // Review C1: discriminant bytes are range-checked, not just shape-decoded.
  const knownBodyTypes = Object.values(CONTENT_TYPE) as number[];
  if (!knownBodyTypes.includes(payload.body_type)) {
    return fail(`unknown body_type ${hexByte(payload.body_type)} (spec §8)`);
  }
  if (payload.receipt_request > 0x03) {
    return fail(
      `receipt_request ${hexByte(payload.receipt_request)} is not a valid 0x01|0x02 bitmask`,
    );
  }
  for (const receipt of payload.receipts) {
    // Spec §9: status is the 0x00–0x06 enum (unknown…rejected).
    if (receipt.status > 0x06) {
      return fail(`unknown receipt status ${hexByte(receipt.status)} (spec §9)`);
    }
    // v2 (ADR 0006): guaranteed by the fixed Byte32; asserted anyway.
    if ("proof" in receipt && receipt.proof.byteLength !== V2_LIMITS.receiptProofBytes) {
      return fail(
        `receipt proof is ${receipt.proof.byteLength} bytes, expected ${V2_LIMITS.receiptProofBytes}`,
      );
    }
  }
  if (payload.text !== undefined && payload.text.byteLength > V1_LIMITS.maxTextBytes) {
    return fail(`text is ${payload.text.byteLength} bytes (max ${V1_LIMITS.maxTextBytes})`);
  }
  if (totalBytes !== undefined && totalBytes > V1_LIMITS.maxPayloadBytes) {
    return fail(
      `payload is ${totalBytes} bytes, exceeds the ${V1_LIMITS.maxPayloadBytes}-byte limit (spec §11)`,
    );
  }
  if (payload.padding.byteLength > V1_LIMITS.maxPaddingBytes) {
    return fail(
      `padding is ${payload.padding.byteLength} bytes (max ${V1_LIMITS.maxPaddingBytes})`,
    );
  }
  if (payload.receipts.length > V1_LIMITS.maxReceipts) {
    return fail(
      `payload carries ${payload.receipts.length} receipts (max ${V1_LIMITS.maxReceipts})`,
    );
  }
  if (payload.attachment_manifests.length > V1_LIMITS.maxAttachmentManifests) {
    return fail(
      `payload carries ${payload.attachment_manifests.length} attachment manifests ` +
        `(max ${V1_LIMITS.maxAttachmentManifests})`,
    );
  }
  if (payload.body_type === CONTENT_TYPE.Text && payload.text === undefined) {
    return fail("body_type 0x01 (text) requires the text field to be present (spec §8)");
  }
  return OK;
}

/** Full payload pipeline on the decrypted payload plaintext (spec §12). */
export function validatePayload(bytes: Uint8Array): ValidationResult {
  try {
    const decoded = tryDecode("CempPayloadV1", decodeCempPayloadV1, bytes);
    if (!decoded.ok) return decoded;
    return validatePayloadFields(decoded.value, bytes.byteLength);
  } catch (e) {
    return fail(`payload validation error: ${errorMessage(e)}`);
  }
}

/** Full v2 payload pipeline (ADR 0006): same field checks and limits as v1. */
export function validatePayloadV2(bytes: Uint8Array): ValidationResult {
  try {
    const decoded = tryDecode("CempPayloadV2", decodeCempPayloadV2, bytes);
    if (!decoded.ok) return decoded;
    return validatePayloadFields(decoded.value, bytes.byteLength);
  } catch (e) {
    return fail(`payload validation error: ${errorMessage(e)}`);
  }
}

/**
 * The payload pipeline for the layout the envelope header's
 * `protocol_version` names (ADR 0006). Explicit dispatch, never a fallback.
 */
export function validatePayloadForVersion(
  protocolVersion: number,
  bytes: Uint8Array,
): ValidationResult {
  if (protocolVersion === PAYLOAD_PROTOCOL_VERSION.V1) {
    return validatePayload(bytes);
  }
  if (protocolVersion === PAYLOAD_PROTOCOL_VERSION.V2) {
    return validatePayloadV2(bytes);
  }
  return fail(`unknown protocol_version ${String(protocolVersion)}`);
}

// ── semantic consistency (spec §12.5) ───────────────────────────────────────

/**
 * Post-decryption cross-checks between the clear envelope header, the
 * decrypted payload, and our own profile id. Any mismatch marks the message
 * `invalid` (no user-visible message, spec §12.5).
 */
export function validateSemanticConsistency(
  header: CempEnvelopeHeaderV1,
  payload: Pick<CempPayloadV1, "message_id" | "body_type" | "recipient_profile_id">,
  ownProfileId: Uint8Array,
): ValidationResult {
  try {
    if (!bytesEqual(payload.message_id, header.message_id)) {
      return fail("payload message_id does not match header message_id (spec §12.5)");
    }
    if (payload.body_type !== header.content_type) {
      return fail(
        `payload body_type ${hexByte(payload.body_type)} does not match header ` +
          `content_type ${hexByte(header.content_type)} (spec §12.5)`,
      );
    }
    if (ownProfileId.byteLength !== 32) {
      return fail(`own profile id is ${ownProfileId.byteLength} bytes, expected 32`);
    }
    if (!bytesEqual(payload.recipient_profile_id, ownProfileId)) {
      return fail("payload recipient_profile_id does not match own profile id (spec §12.5)");
    }
    return OK;
  } catch (e) {
    return fail(`semantic validation error: ${errorMessage(e)}`);
  }
}

// ── protocol version 3 inner plaintext (ADR 0007 §3, §6) ─────────────────────

/**
 * Checks on a decoded `CempInnerV3`, run after AES-GCM and BEFORE signature
 * verification: algorithm id, content type, payload limits, recipient and
 * conversation binding. Signature validity is NOT checked here (it needs the
 * sender's key; see `AuthenticatedSenderResolver` in @cemp/ckb).
 */
export function validateInnerV3Fields(
  inner: CempInnerV3,
  ownProfileId: Uint8Array,
): ValidationResult {
  try {
    if (!algorithmEquals(inner.sig_algorithm, ALGORITHM_ID_BYTES.MlDsa65)) {
      return fail(
        `unknown sig_algorithm (family ${hexByte(inner.sig_algorithm.family)}, ` +
          `parameter ${inner.sig_algorithm.parameter}); v3 requires ML-DSA-65`,
      );
    }
    if (inner.signature.byteLength !== V3_LIMITS.signatureBytes) {
      return fail(`internal: signature is ${inner.signature.byteLength} bytes`);
    }
    if (!isKnownContentType(inner.content_type)) {
      return fail(`unknown content_type ${hexByte(inner.content_type)}`);
    }
    if (inner.content_type !== inner.payload.body_type) {
      return fail(
        `content_type ${hexByte(inner.content_type)} does not match payload body_type ` +
          `${hexByte(inner.payload.body_type)}`,
      );
    }
    const payloadCheck = validatePayloadFields(
      inner.payload,
      encodeCempPayloadV2(inner.payload).byteLength,
    );
    if (!payloadCheck.ok) return payloadCheck;
    if (ownProfileId.byteLength !== 32) {
      return fail(`own profile id is ${ownProfileId.byteLength} bytes, expected 32`);
    }
    if (!bytesEqual(inner.payload.recipient_profile_id, ownProfileId)) {
      return fail("payload recipient_profile_id does not match own profile id");
    }
    if (
      !bytesEqual(
        inner.conversation_id,
        deriveConversationId(inner.sender_profile_id, ownProfileId),
      )
    ) {
      return fail("conversation_id is not H(sender_profile_id, own profile id)");
    }
    return OK;
  } catch (e) {
    return fail(`inner validation error: ${errorMessage(e)}`);
  }
}

/** Full v3 inner pipeline on the AES-GCM plaintext: size gate → strict decode → fields. */
export function validateInnerV3(bytes: Uint8Array, ownProfileId: Uint8Array): ValidationResult {
  try {
    if (bytes.byteLength > V3_LIMITS.maxInnerBytes) {
      return fail(
        `inner plaintext is ${bytes.byteLength} bytes, exceeds the ${V3_LIMITS.maxInnerBytes}-byte limit`,
      );
    }
    const decoded = tryDecode("CempInnerV3", decodeCempInnerV3, bytes);
    if (!decoded.ok) return decoded;
    return validateInnerV3Fields(decoded.value, ownProfileId);
  } catch (e) {
    return fail(`inner validation error: ${errorMessage(e)}`);
  }
}
