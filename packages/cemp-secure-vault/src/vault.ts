/**
 * Secure vault boundary (spec §4.1, Phase 3).
 *
 * Platform-neutral interface; Android Keystore backed implementation first,
 * iOS Keychain/Secure Enclave later (AGENTS.md rule 14). For the earliest
 * testnet prototype a WASM/TypeScript signer may sit behind this interface;
 * production signing migrates into audited Rust/native code.
 *
 * Grounding: key-vault-wasm patterns worth porting (Scrypt log_n=17/r=8/p=1,
 * AES-256-GCM vault file with fresh salt+IV per encryption, HKDF-SHA-256,
 * zeroize-on-drop buffers) are documented in docs/grounding/reference-projects.md.
 * Note: its custom 36/54/72-word mnemonic format must NOT be reused — BIP39
 * 12/24 words only (spec §5.1).
 */

export type VaultState = "locked" | "unlocked" | "uninitialized";

export interface VaultMetadata {
  readonly createdAt: number;
  readonly kdfAlgorithm: "argon2id" | "scrypt";
  readonly biometricEnabled: boolean;
  readonly autoLockSeconds: number;
}

export interface MnemonicReveal {
  /** 12 or 24 English words, valid BIP39 checksum (spec §5.1). */
  readonly words: string[];
}

/**
 * The vault never exports raw key material through this interface except in
 * the explicit, authentication-gated mnemonic reveal flow (spec §5.5).
 * Signing happens inside the vault boundary.
 */
export interface SecureVault {
  readonly state: VaultState;

  createWithNewMnemonic(wordCount: 12 | 24, password: string): Promise<MnemonicReveal>;
  importMnemonic(words: string[], password: string, passphrase?: string): Promise<void>;

  unlock(password: string): Promise<void>;
  unlockWithBiometrics(): Promise<void>;
  lock(): Promise<void>;

  /** Authentication-gated reveal + confirmation test (spec Phase 3 tasks 9–10). */
  revealMnemonic(password: string): Promise<MnemonicReveal>;

  /** Irreversible: reinstall without the mnemonic cannot recover (Phase 3 exit). */
  wipe(): Promise<void>;

  getMetadata(): Promise<VaultMetadata>;
}
