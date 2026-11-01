/**
 * Protocol-wide versioning and algorithm identifiers (spec §14.4).
 * Every serialized CEMP object must carry these identifiers.
 */

/**
 * Profile protocol version (spec §5). Profiles are unchanged by ADR 0006 and
 * still carry and advertise v1.
 */
export const CEMP_PROTOCOL_VERSION = 1;

/**
 * Envelope header `protocol_version` values a receiver accepts (ADR 0006):
 * 1 decodes the payload as `CempPayloadV1`, 2 as `CempPayloadV2`.
 */
export const CEMP_ENVELOPE_PROTOCOL_VERSIONS: readonly number[] = [1, 2];

/**
 * The envelope protocol version every outgoing message is sent as (ADR
 * 0006): no v1 send path remains, so there is nothing to downgrade to.
 */
export const CEMP_SEND_PROTOCOL_VERSION = 2;
export const CEMP_SERIALIZATION_VERSION = 1;

export const ALGORITHM_FAMILY = {
  Signature: "ML-DSA",
  Kem: "ML-KEM",
  Aead: "AES-256-GCM",
  Kdf: "HKDF-SHA-256",
  Hash: "BLAKE2b-256",
} as const;
export type AlgorithmFamily = (typeof ALGORITHM_FAMILY)[keyof typeof ALGORITHM_FAMILY];

/** Algorithm family + parameter set identifiers used in version 1 (spec §14.1). */
export const ALGORITHM_ID = {
  MlDsa65: "ML-DSA-65",
  MlKem768: "ML-KEM-768",
  Aes256Gcm: "AES-256-GCM",
  HkdfSha256: "HKDF-SHA-256",
  Blake2b256: "BLAKE2b-256",
} as const;
export type AlgorithmId = (typeof ALGORITHM_ID)[keyof typeof ALGORITHM_ID];

/**
 * Hard protocol limits (spec §9.1 and Phase 1 field-length work).
 * Values here are the initial protocol maximums; Phase 1 pins every field length.
 */
export const PROTOCOL_LIMITS = {
  /** Hard initial protocol maximum for one encrypted attachment (1 MB). */
  maxAttachmentBytes: 1_048_576,
  /** Preferred compressed chat-image target is 300–500 KB; 1 MB is the hard cap. */
  preferredAttachmentBytes: 512_000,
  maxImageLongestEdgePx: 1280,
  preferredImageLongestEdgePx: 960,
  thumbnailLongestEdgePx: 320,
} as const;
