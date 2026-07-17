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
  LocalDatabase: "CEMP/LOCAL/database/v1",
  ContactExchange: "CEMP/CONTACT/exchange/v1",
  BackupEncryption: "CEMP/BACKUP/encryption/v1",
} as const;
export type KdfDomain = (typeof KDF_DOMAIN)[keyof typeof KDF_DOMAIN];

/** Per-message and per-attachment key derivation (spec §14.1 example). */
export const MESSAGE_KEY_DOMAIN = {
  MessageKey: "CEMP-MESSAGE-KEY-V1",
  AttachmentKey: "CEMP-ATTACHMENT-KEY-V1",
} as const;
export type MessageKeyDomain = (typeof MESSAGE_KEY_DOMAIN)[keyof typeof MESSAGE_KEY_DOMAIN];

/** Signature domain separation (spec §14.2). */
export const SIGNATURE_DOMAIN = {
  Transaction: "CEMP-SIGN-TRANSACTION-V1",
  Profile: "CEMP-SIGN-PROFILE-V1",
  ContactBundle: "CEMP-SIGN-CONTACT-V1",
} as const;
export type SignatureDomain = (typeof SIGNATURE_DOMAIN)[keyof typeof SIGNATURE_DOMAIN];
