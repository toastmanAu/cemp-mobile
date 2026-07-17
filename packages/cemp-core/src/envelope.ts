/**
 * Logical structure of the CEMP message envelope and encrypted payload
 * (spec §6.1, §6.2). These interfaces fix the fields and their semantics;
 * the byte-level serialization is defined in Phase 1 (docs/protocol/) and
 * must not diverge from golden vectors afterwards (AGENTS.md rule 1).
 */

export const CONTENT_TYPE = {
  Text: 0x01,
  Receipt: 0x02,
  AttachmentManifest: 0x03,
} as const;
export type ContentType = (typeof CONTENT_TYPE)[keyof typeof CONTENT_TYPE];

/**
 * Versioned envelope carried in CEMP message-cell data (spec §6.1).
 * Fields that need not be public must live inside the encrypted payload
 * instead of here.
 */
export interface CempEnvelopeV1 {
  protocolVersion: number;
  contentType: ContentType;
  messageId: Uint8Array;
  conversationId: Uint8Array;
  senderProfileId: Uint8Array;
  /** Recipient profile ID, or an encrypted identity block (Phase 1 pins the encoding). */
  recipientIdentity: Uint8Array;
  /** Client wall-clock timestamp, unix seconds. */
  createdAtClient: number;
  replyToMessageId: Uint8Array | null;
  /** Local policy hint only — never proof of receipt (spec §7.5). */
  expiryHint: number | null;
  /** ML-KEM-768 ciphertext for the payload key encapsulation. */
  kemCiphertext: Uint8Array;
  nonce: Uint8Array;
  authenticatedHeader: Uint8Array;
  encryptedPayload: Uint8Array;
}

/** Decrypted inner payload (spec §6.2). Never persist in plaintext — AGENTS.md rule 3. */
export interface EncryptedMessagePayloadV1 {
  messageId: Uint8Array;
  bodyType: ContentType;
  text: string | null;
  attachmentManifests: AttachmentManifestV1[];
  replyToMessageId: Uint8Array | null;
  /** OutPoint (tx hash + index) of the message this responds to (spec §7.3). */
  replyToOutpoint: OutPointRef | null;
  clientTimestamp: number;
  senderDeviceId: Uint8Array;
  receiptRequest: ReceiptRequest | null;
  /** Random padding to obscure payload size (spec §15 mitigation). */
  padding: Uint8Array;
}

/** Attachment manifest as embedded in an encrypted payload (spec §9.3). Phase 10. */
export interface AttachmentManifestV1 {
  attachmentId: Uint8Array;
  ckbfsRoot: Uint8Array;
  chunkOutpoints: OutPointRef[];
  encryptedSize: number;
  plaintextSize: number;
  mimeType: string;
  width: number;
  height: number;
  thumbnail: Uint8Array | null;
  contentHash: Uint8Array;
  cipherHash: Uint8Array;
  encryptionNonce: Uint8Array;
  encryptionAlgorithm: string;
  reclaimGroupId: Uint8Array;
}

/** Minimal CKB out-point reference (tx hash + output index). */
export interface OutPointRef {
  txHash: Uint8Array;
  index: number;
}

/** Receipt request flags inside an encrypted payload (spec §8). */
export interface ReceiptRequest {
  wantDelivered: boolean;
  wantRead: boolean;
}
