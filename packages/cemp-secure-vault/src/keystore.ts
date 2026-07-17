/**
 * Platform keystore boundary (AGENTS.md rule 14).
 *
 * The vault never talks to Android Keystore / iOS Keychain directly; it talks
 * to this interface. The Android implementation (hardware-backed Keystore
 * with `setUserAuthenticationRequired(true)` for the biometric slot) ships in
 * apps/android in a later phase; the iOS Keychain slot is reserved by the
 * same interface. This package ships the interface plus
 * {@link EphemeralSoftwareKeyStore}, a reference implementation for tests and
 * desktop development.
 *
 * Two uses:
 * - Wrap slot 2 of the vault file (biometric unlock): `wrap(vek,
 *   { biometric: true })` stores a blob that only the platform can unwrap
 *   after a biometric prompt.
 * - The database encryption key blob (`cemp.dbkey`, spec Phase 3 task 5):
 *   `wrap(dbKey)` with no biometric flag — the unwrapped key never touches
 *   persistent storage.
 */

/** Options accepted by {@link PlatformKeyStore.wrap}. */
export interface KeyStoreWrapOptions {
  /**
   * Require user biometric authentication on every unwrap. Implementations
   * without biometric support must reject when this is set.
   */
  readonly biometric?: boolean;
}

/**
 * Hardware/OS-backed key wrapping. All methods reject (never throw
 * synchronously) and error messages must not carry key material (rule 2).
 */
export interface PlatformKeyStore {
  /** Stable identifier of the implementation (e.g. "android-keystore"). */
  readonly kind: string;
  /** Whether wrapping is usable at all on this device/install. */
  isAvailable(): Promise<boolean>;
  /** Whether biometric-gated wrap/unwrap can be enrolled on this device. */
  isBiometricAvailable(): Promise<boolean>;
  /** Wrap (encrypt) `key`, returning an opaque persistable blob. */
  wrap(key: Uint8Array, opts?: KeyStoreWrapOptions): Promise<Uint8Array>;
  /**
   * Unwrap a blob produced by {@link wrap}. Rejects when the underlying key
   * is gone (reinstall, keystore reset, {@link deleteKey}) or when the user
   * refuses/cancels the biometric prompt.
   */
  unwrap(blob: Uint8Array): Promise<Uint8Array>;
  /**
   * Irreversibly destroy the wrapping key. All previously produced blobs
   * become undecryptable — this is what makes "reinstall without the
   * mnemonic cannot recover the wallet" hold.
   */
  deleteKey(): Promise<void>;
}

import { aes256GcmDecrypt, aes256GcmEncrypt, randomBytes } from "@cemp/crypto";

const textEncoder = new TextEncoder();

/** AAD context strings for the reference keystore's AES-GCM wrap. */
const WRAP_AAD_PREFIX = "CEMP/KEYSTORE/wrap/v1";

/**
 * Reference {@link PlatformKeyStore}: a random 32-byte wrap key living in
 * process memory. Security properties modelled:
 *
 * - A NEW instance (fresh random key) simulates reinstall / keystore reset:
 *   blobs produced by the old instance can never unwrap.
 * - `deleteKey()` zeroizes the key: all prior blobs become undecryptable.
 * - Biometric blobs carry a flag byte; unwrapping one invokes
 *   `onBiometricPrompt` and rejection makes the unwrap fail.
 *
 * It is NOT a secure keystore — anything sharing process memory can read the
 * key. Production builds use the platform implementations.
 */
export class EphemeralSoftwareKeyStore implements PlatformKeyStore {
  readonly kind = "ephemeral-software";

  readonly #biometricAvailable: boolean;
  readonly #onBiometricPrompt: (() => Promise<boolean>) | undefined;
  #key: Uint8Array | null = randomBytes(32);

  constructor(
    opts: {
      readonly biometricAvailable?: boolean;
      /** Test hook resolving to the user's biometric accept/reject. */
      readonly onBiometricPrompt?: () => Promise<boolean>;
    } = {},
  ) {
    this.#biometricAvailable = opts.biometricAvailable ?? false;
    this.#onBiometricPrompt = opts.onBiometricPrompt;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.#key !== null);
  }

  isBiometricAvailable(): Promise<boolean> {
    return Promise.resolve(this.#key !== null && this.#biometricAvailable);
  }

  wrap(key: Uint8Array, opts: KeyStoreWrapOptions = {}): Promise<Uint8Array> {
    if (this.#key === null) {
      return Promise.reject(new Error("ephemeral keystore: key has been deleted"));
    }
    if (opts.biometric === true && !this.#biometricAvailable) {
      return Promise.reject(new Error("ephemeral keystore: biometrics not available"));
    }
    // Blob layout: flags(1) ‖ nonce(12) ‖ ciphertext‖tag. flags bit0 marks
    // biometric-gated blobs so unwrap knows a prompt is required; the flags
    // byte is bound into the AAD so it cannot be stripped.
    const flags = new Uint8Array([opts.biometric === true ? 1 : 0]);
    const nonce = randomBytes(12);
    const aad = concatBytes(textEncoder.encode(WRAP_AAD_PREFIX), flags);
    const ct = aes256GcmEncrypt(this.#key, nonce, key, aad);
    const blob = new Uint8Array(1 + nonce.length + ct.length);
    blob.set(flags, 0);
    blob.set(nonce, 1);
    blob.set(ct, 1 + nonce.length);
    return Promise.resolve(blob);
  }

  async unwrap(blob: Uint8Array): Promise<Uint8Array> {
    if (this.#key === null) {
      throw new Error("ephemeral keystore: key has been deleted");
    }
    if (blob.length < 1 + 12 + 16) {
      throw new Error("ephemeral keystore: malformed blob");
    }
    const flags = blob[0]!;
    const nonce = blob.slice(1, 13);
    const ct = blob.slice(13);
    if ((flags & 1) === 1) {
      // Biometric-gated blob: prompt first, decrypt only on acceptance.
      const accepted =
        this.#onBiometricPrompt !== undefined ? await this.#onBiometricPrompt() : false;
      if (!accepted) {
        throw new Error("ephemeral keystore: biometric prompt rejected");
      }
    }
    try {
      return aes256GcmDecrypt(
        this.#key,
        nonce,
        ct,
        concatBytes(textEncoder.encode(WRAP_AAD_PREFIX), new Uint8Array([flags])),
      );
    } catch {
      throw new Error("ephemeral keystore: blob cannot be unwrapped by this instance");
    }
  }

  deleteKey(): Promise<void> {
    this.#key?.fill(0);
    this.#key = null;
    return Promise.resolve();
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
