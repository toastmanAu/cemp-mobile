/**
 * Secure vault boundary (spec §4.1, Phase 3).
 *
 * Platform-neutral vault: BIP39 12/24-word generation and import, the
 * encrypted root seed, password and biometric unlock, auto-lock, the
 * authentication-gated reveal and confirmation quiz, and complete wipe.
 * Platform key wrapping goes through {@link PlatformKeyStore} and persistence
 * through {@link VaultStorage} — Android Keystore backed implementations ship
 * in apps/android, iOS Keychain/Secure Enclave later (AGENTS.md rule 14).
 *
 * Grounding: key-vault-wasm patterns worth porting (Scrypt log_n=17/r=8/p=1,
 * AES-256-GCM vault file with fresh salt+IV per encryption, HKDF-SHA-256,
 * zeroize-on-drop buffers) are documented in docs/grounding/reference-projects.md.
 * Note: its custom 36/54/72-word mnemonic format must NOT be reused — BIP39
 * 12/24 words only (spec §5.1).
 *
 * Zeroisation status (best-effort, same stance as @cemp/crypto): live secret
 * buffers (VEK, seed, cached database key) are `.fill(0)`-wiped on lock and
 * wipe. What the JS engine retains — stale typed-array backing stores, GC
 * copies, immutable strings such as mnemonic phrases and passwords — cannot
 * be guaranteed wiped from JavaScript; hardening is a later phase.
 *
 * AGENTS.md rule 2: nothing in this module logs, and no error message or
 * cause carries mnemonics, seeds, secret keys, vault passwords, database
 * keys or plaintext.
 */

import {
  aes256GcmDecrypt,
  aes256GcmEncrypt,
  deriveLocalDatabaseKey,
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
  randomBytes,
  validateMnemonic,
} from "@cemp/crypto";
import { VaultError } from "./errors.js";
import {
  VAULT_FORMAT_VERSION,
  VEK_BYTES,
  decodeSecretPayload,
  encodeSecretPayload,
  parseVaultFile,
  payloadAad,
  serializeVaultFile,
  type VaultFileV1,
  type VaultWordCount,
} from "./format.js";
import {
  NobleKdfEngine,
  resolveKdfParams,
  validateKdfParams,
  KDF_SALT_BYTES,
  type KdfAlgorithm,
  type KdfEngine,
  type KdfOptions,
  type KdfParams,
} from "./kdf.js";
import type { PlatformKeyStore } from "./keystore.js";
import { VAULT_STORAGE_NAME, type VaultStorage } from "./storage.js";

export type VaultState = "locked" | "unlocked" | "uninitialized";

export interface VaultMetadata {
  readonly createdAt: number;
  readonly kdfAlgorithm: KdfAlgorithm;
  readonly biometricEnabled: boolean;
  readonly autoLockSeconds: number;
  readonly wordCount: VaultWordCount;
  /** True when a BIP39 passphrase was mixed in at import (never stored). */
  readonly hasPassphrase: boolean;
}

export interface MnemonicReveal {
  /** 12 or 24 English words, valid BIP39 checksum (spec §5.1). */
  readonly words: string[];
}

/**
 * Mnemonic confirmation quiz (Phase 3 task 10): 1-based word positions the
 * user must reproduce from their written-down phrase.
 */
export interface MnemonicQuiz {
  /** 1-based positions into the mnemonic, ascending, distinct. */
  readonly positions: number[];
}

/** Construction dependencies: platform-neutral seams (rule 14). */
export interface SecureVaultDeps {
  readonly storage: VaultStorage;
  readonly keystore: PlatformKeyStore;
  /**
   * Password-KDF engine (default: pure-JS noble). Hermes builds should pass
   * the native engine — noble argon2/scrypt is unusably slow there (kdf.ts).
   */
  readonly kdfEngine?: KdfEngine;
}

/**
 * Test/vector-generation seam: fixed byte inputs that make vault creation
 * deterministic (golden vectors in packages/cemp-test-vectors). Production
 * callers MUST omit these — injecting known bytes defeats the CSPRNG.
 */
export interface VaultFixedInputs {
  readonly entropy?: Uint8Array;
  readonly vek?: Uint8Array;
  readonly kdfSalt?: Uint8Array;
  readonly passwordSlotNonce?: Uint8Array;
  readonly payloadNonce?: Uint8Array;
  readonly createdAt?: number;
}

export interface CreateVaultOptions {
  /** KDF algorithm + cost overrides (tests use tiny parameters for speed). */
  readonly kdf?: KdfOptions;
  /** Inactivity timeout recorded in the vault file (default 300 s). */
  readonly autoLockSeconds?: number;
  readonly fixedInputs?: VaultFixedInputs;
}

/** Default inactivity timeout (spec Phase 3 task 8). */
export const DEFAULT_AUTO_LOCK_SECONDS = 300;

/**
 * Hard app-side ceiling for the auto-lock timer (review V1): `autoLockSeconds`
 * lives in the vault file's UNAUTHENTICATED meta block, so an evil-maid edit
 * could otherwise stretch the unlock window arbitrarily. The file value is
 * honoured only up to this ceiling (1 hour); the encrypted payload is the
 * authoritative home for a future format v2.
 */
export const MAX_AUTO_LOCK_SECONDS = 3600;

/** Clamp a file-provided auto-lock value to the app-side ceiling (review V1). */
export function clampAutoLockSeconds(seconds: number): number {
  return Math.min(seconds, MAX_AUTO_LOCK_SECONDS);
}

/** AAD context for the password slot's VEK wrap. */
const PASSWORD_WRAP_AAD = "CEMP/VAULT/wrap/password/v1";
const textEncoder = new TextEncoder();

/**
 * The vault never exports raw key material through this interface except in
 * the explicit, authentication-gated mnemonic reveal flow (spec §5.5) and
 * the borrowed-buffer accessors {@link withUnlockedSeed} /
 * {@link getDatabaseKey} consumed by later phases.
 */
export interface SecureVault {
  readonly state: VaultState;

  /**
   * Wall-clock epoch milliseconds at which the inactivity timer is due to fire,
   * or `null` when no timer is armed (any state but `unlocked`).
   *
   * Exists because {@link state} alone is not trustworthy on a suspended
   * runtime: the auto-lock is a `setTimeout`, and a host that freezes JS timers
   * (React Native while the app is backgrounded) leaves `state` reading
   * `"unlocked"` long past the deadline, until the overdue timer is finally
   * dispatched on resume. A caller that must not act on a stale reading — the
   * background tick — compares this deadline against `Date.now()` instead.
   *
   * Reading it is synchronous and side-effect-free: it does NOT extend the
   * window the way {@link touch} does.
   */
  readonly autoLockDeadlineMs: number | null;

  createWithNewMnemonic(
    wordCount: VaultWordCount,
    password: string,
    opts?: CreateVaultOptions,
  ): Promise<MnemonicReveal>;
  importMnemonic(
    words: string[],
    password: string,
    passphrase?: string,
    opts?: CreateVaultOptions,
  ): Promise<void>;

  unlock(password: string): Promise<void>;
  unlockWithBiometrics(): Promise<void>;
  lock(): Promise<void>;

  /**
   * Authentication-gated reveal (spec §5.5): PASSWORD-gated only, never
   * biometric — a stronger gate than ordinary unlock. Works from the locked
   * or unlocked state and does not change it. The BIP39 passphrase is never
   * stored and cannot be recovered by this flow.
   */
  revealMnemonic(password: string): Promise<MnemonicReveal>;

  /**
   * Re-wrap the VEK under a new password (fresh salt/params/nonce). The VEK
   * and the biometric slot are untouched, so biometric unlock survives.
   */
  changePassword(oldPassword: string, newPassword: string): Promise<void>;

  /** Unlocked-only: add/replace the biometric wrap slot. */
  enableBiometrics(): Promise<void>;
  /** Unlocked-only: remove the biometric wrap slot. */
  disableBiometrics(): Promise<void>;

  /** Reset the inactivity timer; no-op unless unlocked. */
  touch(): void;

  /**
   * Run `fn` with the live 64-byte BIP39 seed. BORROWED BUFFER: the seed is
   * zeroized on lock/wipe — callers must copy anything they need to retain
   * and must never let the reference escape into long-lived state. This is
   * how identity derivation (Phase 4+) consumes the seed.
   */
  withUnlockedSeed<T>(fn: (seed: Uint8Array) => T | Promise<T>): Promise<T>;

  /**
   * The 32-byte local-database key, derived via `deriveLocalDatabaseKey` from
   * the live seed (no post-quantum keygen on the unlock path). BORROWED
   * BUFFER, zeroized on lock/wipe; byte-identical to {@link unwrapDatabaseKey}.
   */
  getDatabaseKey(): Promise<Uint8Array>;

  /**
   * The same 32-byte database key, unwrapped from the persisted `cemp.dbkey`
   * keystore blob. Unlocked-only. Caller owns the returned copy.
   */
  unwrapDatabaseKey(): Promise<Uint8Array>;

  /** Confirmation quiz: random 1-based word positions (unlocked-only). */
  generateMnemonicQuiz(wordCount?: number): Promise<MnemonicQuiz>;
  /** Verify quiz answers against the stored mnemonic (unlocked-only). */
  verifyMnemonicQuiz(quiz: MnemonicQuiz, answers: string[]): Promise<boolean>;

  /** Irreversible: reinstall without the mnemonic cannot recover (Phase 3 exit). */
  wipe(): Promise<void>;

  getMetadata(): Promise<VaultMetadata>;
}

/**
 * Platform-neutral {@link SecureVault} implementation. Construct via
 * {@link SecureVaultImpl.open} so the initial state reflects storage.
 */
export class SecureVaultImpl implements SecureVault {
  readonly #storage: VaultStorage;
  readonly #keystore: PlatformKeyStore;
  readonly #kdfEngine: KdfEngine;

  #state: VaultState;
  /** Live secret material, present only while unlocked (see header). */
  #vek: Uint8Array | null = null;
  #seed: Uint8Array | null = null;
  #dbKey: Uint8Array | null = null;
  #autoLockSeconds = DEFAULT_AUTO_LOCK_SECONDS;
  #autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  #autoLockDeadlineMs: number | null = null;

  private constructor(deps: SecureVaultDeps, state: VaultState) {
    this.#storage = deps.storage;
    this.#keystore = deps.keystore;
    this.#kdfEngine = deps.kdfEngine ?? new NobleKdfEngine();
    this.#state = state;
  }

  /**
   * Open a vault over existing storage: state is "locked" when a vault file
   * exists, "uninitialized" otherwise (fresh install or post-wipe).
   */
  static async open(deps: SecureVaultDeps): Promise<SecureVaultImpl> {
    const existing = await deps.storage.read(VAULT_STORAGE_NAME.vaultFile);
    return new SecureVaultImpl(deps, existing === null ? "uninitialized" : "locked");
  }

  get state(): VaultState {
    return this.#state;
  }

  get autoLockDeadlineMs(): number | null {
    return this.#autoLockDeadlineMs;
  }

  /* --------------------------------------------------------- creation -- */

  async createWithNewMnemonic(
    wordCount: VaultWordCount,
    password: string,
    opts: CreateVaultOptions = {},
  ): Promise<MnemonicReveal> {
    await this.#assertCanInitialize();
    const entropy = opts.fixedInputs?.entropy ?? randomBytes(wordCount === 12 ? 16 : 32);
    if (entropy.length !== (wordCount === 12 ? 16 : 32)) {
      throw new VaultError("invalid-mnemonic", "fixed entropy does not match the word count");
    }
    // The phrase exists here only: entropy is stored, never the words; the
    // reveal flow re-derives them. Returned once for the user to write down.
    const words = entropyToMnemonic(entropy).split(" ");
    const seed = mnemonicToSeed(words.join(" "));
    await this.#buildVault({ entropy, seed, hasPassphrase: false }, wordCount, password, opts);
    return { words };
  }

  async importMnemonic(
    words: string[],
    password: string,
    passphrase?: string,
    opts: CreateVaultOptions = {},
  ): Promise<void> {
    await this.#assertCanInitialize();
    const joined = words.join(" ");
    // Map to invalid-mnemonic WITHOUT a cause: library errors could carry
    // phrase fragments (rule 2).
    if (!validateMnemonic(joined)) {
      throw new VaultError("invalid-mnemonic", "mnemonic failed wordlist/checksum validation");
    }
    let entropy: Uint8Array;
    try {
      entropy = mnemonicToEntropy(joined);
    } catch {
      throw new VaultError("invalid-mnemonic", "mnemonic failed wordlist/checksum validation");
    }
    const wordCount: VaultWordCount = entropy.length === 16 ? 12 : 24;
    if (entropy.length !== 16 && entropy.length !== 32) {
      throw new VaultError("invalid-mnemonic", "mnemonic must encode 16 or 32 bytes of entropy");
    }
    const normalizedPassphrase = passphrase === "" ? undefined : passphrase;
    const seed = mnemonicToSeed(joined, normalizedPassphrase);
    await this.#buildVault(
      { entropy, seed, hasPassphrase: normalizedPassphrase !== undefined },
      wordCount,
      password,
      opts,
    );
  }

  async #assertCanInitialize(): Promise<void> {
    const existing = await this.#storage.read(VAULT_STORAGE_NAME.vaultFile);
    if (existing !== null || this.#state !== "uninitialized") {
      throw new VaultError("already-initialized", "a vault already exists; wipe it first");
    }
  }

  /** Shared creation path for generate/import. Ends in the unlocked state. */
  async #buildVault(
    payload: { entropy: Uint8Array; seed: Uint8Array; hasPassphrase: boolean },
    wordCount: VaultWordCount,
    password: string,
    opts: CreateVaultOptions,
  ): Promise<void> {
    const fixed = opts.fixedInputs ?? {};
    const salt = fixed.kdfSalt ?? randomBytes(KDF_SALT_BYTES);
    const kdf = resolveKdfParams(opts.kdf, salt);
    validateKdfParams(kdf); // creation overrides are validated like file input
    const kek = await this.#kdfEngine.deriveKek(password, kdf);

    const vek = fixed.vek ?? randomBytes(VEK_BYTES);
    if (vek.length !== VEK_BYTES) {
      throw new VaultError("corrupt-vault", "fixed VEK has an invalid length");
    }
    const passwordSlotNonce = fixed.passwordSlotNonce ?? randomBytes(12);
    const passwordSlot = {
      nonce: passwordSlotNonce,
      wrappedVek: aes256GcmEncrypt(
        kek,
        passwordSlotNonce,
        vek,
        textEncoder.encode(PASSWORD_WRAP_AAD),
      ),
    };
    kek.fill(0);

    const header = {
      version: VAULT_FORMAT_VERSION,
      kdf,
      passwordSlot,
      biometricSlot: null,
    } as const;
    const payloadNonce = fixed.payloadNonce ?? randomBytes(12);
    const payloadPlaintext = encodeSecretPayload(payload);
    const ct = aes256GcmEncrypt(vek, payloadNonce, payloadPlaintext, payloadAad(header));
    payloadPlaintext.fill(0);
    payload.entropy.fill(0);

    const file: VaultFileV1 = {
      version: VAULT_FORMAT_VERSION,
      kdf,
      passwordSlot,
      biometricSlot: null,
      payload: { nonce: payloadNonce, ct },
      meta: {
        createdAt: fixed.createdAt ?? Date.now(),
        wordCount,
        hasPassphrase: payload.hasPassphrase,
        autoLockSeconds: opts.autoLockSeconds ?? DEFAULT_AUTO_LOCK_SECONDS,
      },
    };

    // Wrap the database key FIRST: if the keystore fails, nothing is
    // persisted and a retry starts clean (idempotency, AGENTS.md rule 5).
    const dbKey = deriveLocalDatabaseKey(payload.seed);
    let dbKeyBlob: Uint8Array;
    try {
      dbKeyBlob = await this.#keystore.wrap(dbKey);
    } catch (e) {
      dbKey.fill(0);
      throw new VaultError(
        "keystore-error",
        "platform keystore failed to wrap the database key",
        e,
      );
    }
    dbKey.fill(0);

    await this.#storage.write(VAULT_STORAGE_NAME.vaultFile, serializeVaultFile(file));
    await this.#storage.write(VAULT_STORAGE_NAME.databaseKey, dbKeyBlob);

    this.#setUnlocked(vek, payload.seed, file.meta.autoLockSeconds);
  }

  /* ------------------------------------------------------------ unlock -- */

  async unlock(password: string): Promise<void> {
    const file = await this.#readVaultFile();
    const kek = await this.#kdfEngine.deriveKek(password, file.kdf);
    let vek: Uint8Array;
    try {
      vek = aes256GcmDecrypt(
        kek,
        file.passwordSlot.nonce,
        file.passwordSlot.wrappedVek,
        textEncoder.encode(PASSWORD_WRAP_AAD),
      );
    } catch {
      // Wrong password and a tampered wrap slot are indistinguishable (both
      // are AES-GCM authentication failures) — by design.
      throw new VaultError("wrong-password", "vault password authentication failed");
    } finally {
      kek.fill(0);
    }
    let payload: { entropy: Uint8Array; seed: Uint8Array };
    try {
      payload = this.#decryptPayload(file, vek, "wrong-password");
    } catch (e) {
      vek.fill(0); // V3: never keep an unusable VEK alive (review V3).
      throw e;
    }
    this.#setUnlocked(vek, payload.seed, clampAutoLockSeconds(file.meta.autoLockSeconds));
    payload.entropy.fill(0);
  }

  async unlockWithBiometrics(): Promise<void> {
    const file = await this.#readVaultFile();
    if (file.biometricSlot === null) {
      throw new VaultError("biometric-unavailable", "biometric unlock is not enabled");
    }
    let vek: Uint8Array;
    try {
      vek = await this.#keystore.unwrap(file.biometricSlot.wrappedVek);
    } catch {
      // Prompt refused/cancelled, or the platform key is gone (reinstall,
      // keystore reset). Both deny access identically.
      throw new VaultError("biometric-denied", "biometric authentication failed");
    }
    if (vek.length !== VEK_BYTES) {
      vek.fill(0);
      throw new VaultError("corrupt-vault", "biometric unwrap returned an invalid VEK");
    }
    // The VEK authenticated itself by decrypting the payload; a failure here
    // means the file was tampered with, not a denied biometric.
    let payload: { entropy: Uint8Array; seed: Uint8Array };
    try {
      payload = this.#decryptPayload(file, vek, "corrupt-vault");
    } catch (e) {
      vek.fill(0); // V3
      throw e;
    }
    this.#setUnlocked(vek, payload.seed, clampAutoLockSeconds(file.meta.autoLockSeconds));
    payload.entropy.fill(0);
  }

  lock(): Promise<void> {
    this.#clearAutoLockTimer();
    this.#clearLiveState();
    if (this.#state === "unlocked") {
      this.#state = "locked";
    }
    return Promise.resolve();
  }

  touch(): void {
    if (this.#state === "unlocked") {
      this.#startAutoLockTimer();
    }
  }

  /* -------------------------------------------- password-gated flows -- */

  async revealMnemonic(password: string): Promise<MnemonicReveal> {
    const file = await this.#readVaultFile();
    const kek = await this.#kdfEngine.deriveKek(password, file.kdf);
    let vek: Uint8Array;
    try {
      vek = aes256GcmDecrypt(
        kek,
        file.passwordSlot.nonce,
        file.passwordSlot.wrappedVek,
        textEncoder.encode(PASSWORD_WRAP_AAD),
      );
    } catch {
      throw new VaultError("wrong-password", "vault password authentication failed");
    } finally {
      kek.fill(0);
    }
    try {
      const payload = this.#decryptPayload(file, vek, "wrong-password");
      const reveal = { words: entropyToMnemonic(payload.entropy).split(" ") };
      payload.entropy.fill(0);
      payload.seed.fill(0);
      return reveal;
    } finally {
      vek.fill(0);
    }
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const file = await this.#readVaultFile();
    const oldKek = await this.#kdfEngine.deriveKek(oldPassword, file.kdf);
    let vek: Uint8Array;
    try {
      vek = aes256GcmDecrypt(
        oldKek,
        file.passwordSlot.nonce,
        file.passwordSlot.wrappedVek,
        textEncoder.encode(PASSWORD_WRAP_AAD),
      );
    } catch {
      throw new VaultError("wrong-password", "vault password authentication failed");
    } finally {
      oldKek.fill(0);
    }

    // Fresh salt + nonce, same algorithm and cost parameters. Only the
    // 32-byte VEK is re-wrapped; the payload stays under the same VEK (it is
    // re-encrypted with a fresh nonce because the header it authenticates
    // changed), and the biometric slot is carried over untouched.
    const newKdf: KdfParams = { ...file.kdf, salt: randomBytes(KDF_SALT_BYTES) };
    const newKek = await this.#kdfEngine.deriveKek(newPassword, newKdf);
    const newSlotNonce = randomBytes(12);
    const newPasswordSlot = {
      nonce: newSlotNonce,
      wrappedVek: aes256GcmEncrypt(
        newKek,
        newSlotNonce,
        vek,
        textEncoder.encode(PASSWORD_WRAP_AAD),
      ),
    };
    newKek.fill(0);

    const payloadPlaintext = this.#decryptPayloadBytes(file, vek, "wrong-password");
    const newHeader = {
      version: VAULT_FORMAT_VERSION,
      kdf: newKdf,
      passwordSlot: newPasswordSlot,
      biometricSlot: file.biometricSlot,
    } as const;
    const newPayloadNonce = randomBytes(12);
    const newPayload = {
      nonce: newPayloadNonce,
      ct: aes256GcmEncrypt(vek, newPayloadNonce, payloadPlaintext, payloadAad(newHeader)),
    };
    payloadPlaintext.fill(0);
    vek.fill(0);

    const updated: VaultFileV1 = {
      ...file,
      kdf: newKdf,
      passwordSlot: newPasswordSlot,
      payload: newPayload,
    };
    await this.#storage.write(VAULT_STORAGE_NAME.vaultFile, serializeVaultFile(updated));
  }

  /* --------------------------------------------------------- biometrics -- */

  async enableBiometrics(): Promise<void> {
    this.#assertUnlocked();
    if (!(await this.#keystore.isBiometricAvailable())) {
      throw new VaultError("biometric-unavailable", "biometrics are not available on this device");
    }
    const file = await this.#readVaultFile();
    if (file.biometricSlot !== null) {
      return; // idempotent: already enabled
    }
    let blob: Uint8Array;
    try {
      blob = await this.#keystore.wrap(this.#requireVek(), { biometric: true });
    } catch (e) {
      throw new VaultError("keystore-error", "platform keystore failed to wrap the VEK", e);
    }
    await this.#rewriteSlots(file, file.passwordSlot, { wrappedVek: blob });
  }

  async disableBiometrics(): Promise<void> {
    this.#assertUnlocked();
    const file = await this.#readVaultFile();
    if (file.biometricSlot === null) {
      return; // idempotent: already disabled
    }
    // The keystore key itself is NOT deleted: it also protects cemp.dbkey.
    await this.#rewriteSlots(file, file.passwordSlot, null);
  }

  /**
   * Re-encrypt the payload under the live VEK with a fresh nonce after a
   * wrap-slot edit, so the payload AAD always matches the stored header.
   */
  async #rewriteSlots(
    file: VaultFileV1,
    passwordSlot: VaultFileV1["passwordSlot"],
    biometricSlot: VaultFileV1["biometricSlot"],
  ): Promise<void> {
    const vek = this.#requireVek();
    const payloadPlaintext = this.#decryptPayloadBytes(file, vek, "corrupt-vault");
    const header = {
      version: VAULT_FORMAT_VERSION,
      kdf: file.kdf,
      passwordSlot,
      biometricSlot,
    } as const;
    const payloadNonce = randomBytes(12);
    const payload = {
      nonce: payloadNonce,
      ct: aes256GcmEncrypt(vek, payloadNonce, payloadPlaintext, payloadAad(header)),
    };
    payloadPlaintext.fill(0);
    const updated: VaultFileV1 = { ...file, passwordSlot, biometricSlot, payload };
    await this.#storage.write(VAULT_STORAGE_NAME.vaultFile, serializeVaultFile(updated));
  }

  /* ------------------------------------------------------- key access -- */

  async withUnlockedSeed<T>(fn: (seed: Uint8Array) => T | Promise<T>): Promise<T> {
    this.#assertUnlocked();
    return await fn(this.#requireSeed());
  }

  getDatabaseKey(): Promise<Uint8Array> {
    this.#assertUnlocked();
    this.#dbKey ??= deriveLocalDatabaseKey(this.#requireSeed());
    return Promise.resolve(this.#dbKey);
  }

  async unwrapDatabaseKey(): Promise<Uint8Array> {
    this.#assertUnlocked();
    const blob = await this.#storage.read(VAULT_STORAGE_NAME.databaseKey);
    if (blob === null) {
      throw new VaultError("keystore-error", "wrapped database key is missing from storage");
    }
    try {
      return await this.#keystore.unwrap(blob);
    } catch (e) {
      throw new VaultError(
        "keystore-error",
        "platform keystore failed to unwrap the database key",
        e,
      );
    }
  }

  /* -------------------------------------------------------------- quiz -- */

  async generateMnemonicQuiz(wordCount = 3): Promise<MnemonicQuiz> {
    this.#assertUnlocked();
    const words = await this.#mnemonicWordsWhileUnlocked();
    const count = Math.min(Math.max(1, wordCount), words.length);
    // Partial Fisher-Yates over a position pool, CSPRNG-driven.
    const pool = Array.from({ length: words.length }, (_, i) => i);
    for (let i = 0; i < count; i++) {
      const j = i + (randomBytes(1)[0]! % (pool.length - i));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }
    const positions = pool
      .slice(0, count)
      .map((i) => i + 1)
      .sort((a, b) => a - b);
    return { positions };
  }

  async verifyMnemonicQuiz(quiz: MnemonicQuiz, answers: string[]): Promise<boolean> {
    this.#assertUnlocked();
    if (answers.length !== quiz.positions.length) {
      return false;
    }
    const words = await this.#mnemonicWordsWhileUnlocked();
    return quiz.positions.every(
      (position, i) =>
        position >= 1 &&
        position <= words.length &&
        answers[i]!.trim().toLowerCase() === words[position - 1],
    );
  }

  /** Decrypt the payload with the live VEK to reconstruct the phrase, then wipe. */
  async #mnemonicWordsWhileUnlocked(): Promise<string[]> {
    const file = await this.#readVaultFile();
    const payload = this.#decryptPayload(file, this.#requireVek(), "corrupt-vault");
    try {
      return entropyToMnemonic(payload.entropy).split(" ");
    } finally {
      payload.entropy.fill(0);
      payload.seed.fill(0);
    }
  }

  /* -------------------------------------------------------------- wipe -- */

  async wipe(): Promise<void> {
    this.#clearAutoLockTimer();
    this.#clearLiveState();
    // Delete local history material regardless of keystore outcome (rule 8
    // spirit: local state is ours to destroy). Both deletes are idempotent.
    await this.#storage.delete(VAULT_STORAGE_NAME.vaultFile);
    await this.#storage.delete(VAULT_STORAGE_NAME.databaseKey);
    try {
      await this.#keystore.deleteKey();
    } catch (e) {
      throw new VaultError("keystore-error", "platform keystore failed to delete its key", e);
    }
    this.#state = "uninitialized";
  }

  async getMetadata(): Promise<VaultMetadata> {
    const file = await this.#readVaultFile();
    return {
      createdAt: file.meta.createdAt,
      kdfAlgorithm: file.kdf.alg,
      biometricEnabled: file.biometricSlot !== null,
      autoLockSeconds: clampAutoLockSeconds(file.meta.autoLockSeconds),
      wordCount: file.meta.wordCount,
      hasPassphrase: file.meta.hasPassphrase,
    };
  }

  /* ----------------------------------------------------------- internal -- */

  async #readVaultFile(): Promise<VaultFileV1> {
    const bytes = await this.#storage.read(VAULT_STORAGE_NAME.vaultFile);
    if (bytes === null) {
      throw new VaultError("not-initialized", "no vault exists on this install");
    }
    return parseVaultFile(bytes);
  }

  /** Decrypt + decode the secret payload; AES-GCM failure maps to `code`. */
  #decryptPayload(
    file: VaultFileV1,
    vek: Uint8Array,
    code: "wrong-password" | "corrupt-vault",
  ): { entropy: Uint8Array; seed: Uint8Array } {
    const plaintext = this.#decryptPayloadBytes(file, vek, code);
    try {
      return decodeSecretPayload(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  #decryptPayloadBytes(
    file: VaultFileV1,
    vek: Uint8Array,
    code: "wrong-password" | "corrupt-vault",
  ): Uint8Array {
    const aad = payloadAad(file);
    try {
      return aes256GcmDecrypt(vek, file.payload.nonce, file.payload.ct, aad);
    } catch {
      throw new VaultError(
        code,
        code === "wrong-password"
          ? "vault password authentication failed"
          : "vault payload authentication failed",
      );
    }
  }

  #assertUnlocked(): void {
    if (this.#state === "uninitialized") {
      throw new VaultError("not-initialized", "no vault exists on this install");
    }
    if (this.#state === "locked") {
      throw new VaultError("locked", "the vault is locked");
    }
  }

  #requireVek(): Uint8Array {
    this.#assertUnlocked();
    return this.#vek!;
  }

  #requireSeed(): Uint8Array {
    this.#assertUnlocked();
    return this.#seed!;
  }

  /** Enter the unlocked state, wiping any previously live buffers first. */
  #setUnlocked(vek: Uint8Array, seed: Uint8Array, autoLockSeconds: number): void {
    this.#clearLiveState();
    this.#vek = vek;
    this.#seed = seed;
    this.#autoLockSeconds = autoLockSeconds;
    this.#state = "unlocked";
    this.#startAutoLockTimer();
  }

  /**
   * Best-effort zeroisation of all live key material (module header documents
   * the JavaScript limits). This is the "locking removes usable key material
   * from ordinary application state" exit criterion.
   */
  #clearLiveState(): void {
    this.#vek?.fill(0);
    this.#seed?.fill(0);
    this.#dbKey?.fill(0);
    this.#vek = null;
    this.#seed = null;
    this.#dbKey = null;
  }

  #startAutoLockTimer(): void {
    this.#clearAutoLockTimer();
    const timer = setTimeout(() => {
      void this.lock();
    }, this.#autoLockSeconds * 1000);
    // Keep Node processes from being held open by the vault's idle timer.
    if (typeof (timer as { unref?: unknown }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.#autoLockTimer = timer;
    // Recorded alongside the timer so a caller can tell "the deadline has
    // passed but the timer has not been dispatched yet" from "still live".
    this.#autoLockDeadlineMs = Date.now() + this.#autoLockSeconds * 1000;
  }

  #clearAutoLockTimer(): void {
    if (this.#autoLockTimer !== null) {
      clearTimeout(this.#autoLockTimer);
      this.#autoLockTimer = null;
    }
    this.#autoLockDeadlineMs = null;
  }
}
