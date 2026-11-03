/**
 * HKDF domain-separation strings (spec §5.1, §14.2). These strings are part of
 * the protocol: changing one changes every derived key. Bump the /v1 suffix
 * rather than editing in place (AGENTS.md rule 13).
 */

/** Sub-seed derivation from the BIP39 root seed (spec §5.1). */
export const KDF_DOMAIN = {
  IdentityMlDsa: "CEMP/CKB/ML-DSA/identity/v1",
  MessagingMlKem: "CEMP/CKB/ML-KEM/messaging/v1",
  /**
   * Expansion of the 32-byte messaging sub-seed to the FIPS-203 64-byte
   * ML-KEM keygen seed (spec §4). NOT a standalone sub-seed domain: it is
   * applied on top of `MessagingMlKem`'s output, never on the BIP39 seed.
   */
  MlKemKeygen: "CEMP/CKB/ML-KEM/messaging/v1/keygen",
  /**
   * Profile key rotation (spec §5.3 key-rotation chain, protocol §5):
   * rotation N re-derives each sub-seed as HKDF(baseSubSeed, salt nil,
   * info = rotationDomain ‖ u32le(N)). The base domains stay stable; the
   * rotation suffix is what changes the keys.
   */
  RotationMlDsa: "CEMP/CKB/ML-DSA/identity/v1/rotation",
  RotationMlKem: "CEMP/CKB/ML-KEM/messaging/v1/rotation",
  LocalDatabase: "CEMP/LOCAL/database/v1",
  ContactExchange: "CEMP/CONTACT/exchange/v1",
  BackupEncryption: "CEMP/BACKUP/encryption/v1",
} as const;
export type KdfDomain = (typeof KDF_DOMAIN)[keyof typeof KDF_DOMAIN];

/** Per-message and per-attachment key derivation (spec §14.1 example). */
export const MESSAGE_KEY_DOMAIN = {
  MessageKey: "CEMP-MESSAGE-KEY-V1",
  AttachmentKey: "CEMP-ATTACHMENT-KEY-V1",
  /**
   * Per-message receipt key (ADR 0006): same HKDF-Extract as the message key,
   * own Expand info, so it reveals nothing about the message or attachment
   * keys. Both the sender and the recipient hold it.
   */
  ReceiptKey: "CEMP-RECEIPT-KEY-V1",
} as const;
export type MessageKeyDomain = (typeof MESSAGE_KEY_DOMAIN)[keyof typeof MESSAGE_KEY_DOMAIN];

/**
 * Protocol version 3 key schedule (ADR 0007). The sender id is no longer in
 * the clear header, so a receiver cannot know it before decryption; the v3
 * Expand info is `domain ‖ recipient_id` only. The sender is bound instead by
 * the ML-DSA signature inside the plaintext, which covers the KEM ciphertext
 * and the recipient id. Distinct domain strings keep v3 keys separate from
 * every v1/v2 key even for identical inputs.
 */
export const MESSAGE_KEY_DOMAIN_V3 = {
  MessageKey: "CEMP-MESSAGE-KEY-V3",
  AttachmentKey: "CEMP-ATTACHMENT-KEY-V3",
  ReceiptKey: "CEMP-RECEIPT-KEY-V3",
} as const;
export type MessageKeyDomainV3 = (typeof MESSAGE_KEY_DOMAIN_V3)[keyof typeof MESSAGE_KEY_DOMAIN_V3];

/**
 * HMAC domain of the receipt proof (ADR 0006):
 * proof = HMAC-SHA256(receipt_key, "CEMP-RECEIPT-PROOF-V1" ‖ message_id[16] ‖ status[1]).
 */
export const RECEIPT_PROOF_DOMAIN = "CEMP-RECEIPT-PROOF-V1";

/** Signature domain separation (spec §14.2). */
export const SIGNATURE_DOMAIN = {
  Transaction: "CEMP-SIGN-TRANSACTION-V1",
  Profile: "CEMP-SIGN-PROFILE-V1",
  ContactBundle: "CEMP-SIGN-CONTACT-V1",
} as const;
export type SignatureDomain = (typeof SIGNATURE_DOMAIN)[keyof typeof SIGNATURE_DOMAIN];
