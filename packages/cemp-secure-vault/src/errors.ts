/**
 * Error types for @cemp/secure-vault.
 *
 * Every vault failure surfaces as {@link VaultError} with a machine-readable
 * `code`, so callers (UI, Phase 6 database wiring) catch one type and switch
 * on the code instead of pattern-matching messages.
 *
 * AGENTS.md rule 2: messages and causes must never carry mnemonics, seeds,
 * secret keys, vault passwords, database keys or plaintext. Wrong-password
 * and corrupt-payload both surface as AES-GCM authentication failures; the
 * password path maps both to "wrong-password" so one cannot be distinguished
 * from the other at the API. Library causes are forwarded only when they are
 * fixed strings about tags/shapes (noble AES-GCM, JSON parse positions) —
 * never when they could embed user input (mnemonic import maps to
 * "invalid-mnemonic" with no cause).
 */

export const VAULT_ERROR_CODE = {
  /** Password KDF+unwrap or payload authentication failed (indistinguishable). */
  WrongPassword: "wrong-password",
  /** Operation requires the unlocked state. */
  Locked: "locked",
  /** No vault file exists in storage (fresh install, or after wipe). */
  NotInitialized: "not-initialized",
  /** A vault file already exists; create/import refuses to overwrite it. */
  AlreadyInitialized: "already-initialized",
  /** Vault file failed to parse or authenticate (shape, version, algorithm). */
  CorruptVault: "corrupt-vault",
  /** Mnemonic failed wordlist/checksum validation. */
  InvalidMnemonic: "invalid-mnemonic",
  /** Biometric unlock requested but no biometric wrap slot exists. */
  BiometricUnavailable: "biometric-unavailable",
  /** Biometric prompt rejected, or the keystore key is gone. */
  BiometricDenied: "biometric-denied",
  /** KDF parameters in a parsed vault file exceed the safety caps (DoS guard). */
  KdfParamsOutOfRange: "kdf-params-out-of-range",
  /** The platform keystore failed outside the biometric flow. */
  KeystoreError: "keystore-error",
} as const;
export type VaultErrorCode = (typeof VAULT_ERROR_CODE)[keyof typeof VAULT_ERROR_CODE];

/** All failures of @cemp/secure-vault are reported as this type. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VaultError";
    this.code = code;
  }
}
