/**
 * CryptoProvider — the platform-neutral cryptography boundary (spec §4.2).
 *
 * Implementations:
 * - Early testnet prototype: WASM/TypeScript signer behind this interface.
 * - Production: audited Rust or native code (packages/cemp-secure-vault),
 *   signing without exporting secret keys to ordinary JavaScript.
 *
 * The envelope/context shapes below mirror packages/cemp-core protocol types.
 * They are re-declared structurally so this package stays independently
 * compilable during Phase 0; Phase 1 unifies them against the wire spec.
 */

/** Opaque handle to secret key material held inside a vault — never raw bytes. */
export interface KeyReference {
  readonly id: string;
}

export interface IdentityKeys {
  readonly mlDsaPublicKey: Uint8Array;
  readonly mlKemPublicKey: Uint8Array;
  readonly mlDsaSecretKeyRef: KeyReference;
  readonly mlKemSecretKeyRef: KeyReference;
}

/** Fields bound as AEAD additional data (spec §6.2). */
export interface EncryptionContext {
  readonly protocolVersion: number;
  readonly network: string;
  readonly senderProfileId: Uint8Array;
  readonly recipientProfileId: Uint8Array;
  readonly messageId: Uint8Array;
  readonly conversationId: Uint8Array;
  readonly payloadType: number;
  /** CKB output identity where available (spec §6.2). */
  readonly ckbOutputIdentity: Uint8Array | null;
}

export interface EncryptedEnvelope {
  readonly kemCiphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authenticatedHeader: Uint8Array;
  readonly encryptedPayload: Uint8Array;
}

export interface CryptoProvider {
  generateIdentity(seed: Uint8Array): Promise<IdentityKeys>;
  encryptForRecipient(
    plaintext: Uint8Array,
    recipientKemPublicKey: Uint8Array,
    context: EncryptionContext,
  ): Promise<EncryptedEnvelope>;
  decryptEnvelope(
    envelope: EncryptedEnvelope,
    recipientKemSecretKeyRef: KeyReference,
  ): Promise<Uint8Array>;
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
