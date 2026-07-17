/**
 * CryptoProvider — the platform-neutral cryptography boundary (spec §4.2).
 *
 * Implementations:
 * - Phase 2 testnet implementation: the pure-TypeScript functions in this
 *   package (`identity.ts`, `envelope.ts`) wired behind this interface.
 * - Production: audited Rust or native code (packages/cemp-secure-vault),
 *   decapsulating and signing without exporting secret keys to ordinary
 *   JavaScript.
 *
 * Wire shapes are the Phase 1 Molecule codec types from @cemp/core
 * (`codec.CempEnvelopeHeaderV1` & co.): the Phase 0 structural re-declarations
 * were removed when @cemp/crypto gained its sanctioned dependency on
 * @cemp/core (Phase 2). iOS/native implementations only need to reproduce
 * this interface (AGENTS.md rule 14).
 */

import type {
  DecryptEnvelopeResult,
  EncryptEnvelopeParams,
  EncryptEnvelopeResult,
} from "./envelope.js";
import type { IdentityKeyBundle } from "./identity.js";

/** Opaque handle to secret key material held inside a vault — never raw bytes. */
export interface KeyReference {
  readonly id: string;
}

/**
 * decryptEnvelope through a vault boundary: the ML-KEM secret key never
 * leaves the vault and is addressed by reference instead of raw bytes.
 */
export interface VaultDecryptEnvelopeParams {
  readonly envelopeBytes: Uint8Array;
  readonly recipientKemSecretKeyRef: KeyReference;
  readonly ownProfileId: Uint8Array;
}

export interface CryptoProvider {
  /**
   * Derive the full identity key bundle from a 64-byte BIP39 seed (spec §4,
   * §5.1). Deterministic per seed. Vault implementations copy the secret
   * material into protected storage and wipe the JS-side bundle
   * (`wipeIdentityKeyBundle`).
   */
  deriveIdentityKeys(bip39Seed: Uint8Array): Promise<IdentityKeyBundle>;
  /**
   * Encrypt an encoded `CempPayloadV1` into a serialized `CempEnvelopeV1`
   * (spec §7). Nonce and encapsulation randomness come from the OS CSPRNG;
   * the test-only overrides of `encryptEnvelope` are deliberately not part of
   * this interface.
   */
  encryptEnvelope(params: EncryptEnvelopeParams): Promise<EncryptEnvelopeResult>;
  /**
   * Validate (spec §12: shape, version, §11 limits BEFORE decapsulation) and
   * decrypt an envelope (spec §7.2). Implementations MUST surface every
   * failure as `CempCryptoError` and never return partial plaintext.
   */
  decryptEnvelope(params: VaultDecryptEnvelopeParams): Promise<DecryptEnvelopeResult>;
  /**
   * Sign a CKB transaction with ML-DSA-65. Generic over the transaction type
   * until cemp-ckb pins the concrete builder type in Phase 4.
   *
   * MAINNET GATE (spec §14.3): the implementation must commit to the exact
   * reviewed CKB sighash-all construction expected by the deployed lock — the
   * prototype's transaction-hash-only digest is NOT acceptable.
   */
  signTransaction<TTransaction>(
    transaction: TTransaction,
    signingKeyRef: KeyReference,
  ): Promise<TTransaction>;
}
