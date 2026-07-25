/**
 * Image message send orchestration (spec §6 + §9). Owns the attachment-key
 * coordination: ONE fresh KEM encapsulation drives both the chunk encryption
 * key and the message envelope. Lives here (not in @cemp/ckb) because the
 * reverse dependency would be a cycle.
 */
import type { CempClient, CempMessageTypeRef, MessagePublisher, MlDsaV2TxSigner } from "@cemp/ckb";
import { codec } from "@cemp/core";
import { deriveSendAttachmentKey } from "@cemp/crypto";
import type { ImageCodec, ImageEncodeFormat } from "./codec.js";
import {
  type AttachmentChunkJournal,
  buildManifestForCommittedChunks,
  prepareAttachmentChunks,
  publishAttachmentChunks,
} from "./send.js";

export interface PublishImageMessageDeps {
  readonly codec: ImageCodec;
  readonly client: CempClient;
  readonly signer: MlDsaV2TxSigner;
  readonly messageType: CempMessageTypeRef;
  readonly journal: AttachmentChunkJournal;
  /** Reuses publishText's journal/monitor/resume for the message cell. */
  readonly publisher: Pick<MessagePublisher, "publishText">;
  readonly senderProfileId: Uint8Array;
  readonly senderDeviceId: Uint8Array;
  /** CSPRNG source (injectable for tests). MUST be cryptographically random in prod. */
  readonly randomBytes: (n: number) => Uint8Array;
}

export interface PublishImageMessageInput {
  readonly messageRowId: number;
  readonly logicalMessageId: string;
  readonly recipientProfileIdHex: string;
  readonly recipientKemPublicKey: Uint8Array;
  readonly recipientProfileId: Uint8Array;
  readonly sourceBytes: Uint8Array;
  readonly caption?: string;
  readonly format?: ImageEncodeFormat;
  readonly timeoutMs?: number;
}

export interface PublishImageMessageResult {
  readonly chunksTxHash: string;
  readonly messageTxHash: string;
  readonly manifest: codec.AttachmentManifestV1Encodable;
  readonly chunkCount: number;
  readonly plaintextSize: number;
}

export async function publishImageMessage(
  deps: PublishImageMessageDeps,
  input: PublishImageMessageInput,
): Promise<PublishImageMessageResult> {
  // §6 SAFETY: fresh, single-use encapsulation randomness per message.
  const kemMessage = deps.randomBytes(32);
  const nonce = deps.randomBytes(12);
  const attachmentKey = deriveSendAttachmentKey({
    recipientKemPublicKey: input.recipientKemPublicKey,
    kemMessage,
    nonce,
    senderProfileId: deps.senderProfileId,
    recipientProfileId: input.recipientProfileId,
  });

  try {
    const prepared = await prepareAttachmentChunks(
      deps.codec,
      input.sourceBytes,
      attachmentKey,
      input.format === undefined ? {} : { format: input.format },
    );
    const published = await publishAttachmentChunks(
      { client: deps.client, signer: deps.signer, journal: deps.journal, messageType: deps.messageType },
      prepared,
      input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
    );
    const reclaimGroupId = deps.randomBytes(16);
    const manifest = buildManifestForCommittedChunks({
      chunks: prepared,
      chunksTxHash: published.chunksTxHash,
      reclaimGroupId,
    });
    const messageResult = await deps.publisher.publishText({
      messageRowId: input.messageRowId,
      logicalMessageId: input.logicalMessageId,
      text: input.caption ?? "",
      recipientProfileIdHex: input.recipientProfileIdHex,
      contentType: 0x03,
      attachmentManifests: [manifest],
      attachmentEnvelope: { kemMessage, nonce },
      receiptRequest: 1,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    return {
      chunksTxHash: published.chunksTxHash,
      messageTxHash: messageResult.txHash,
      manifest,
      chunkCount: published.chunkCount,
      plaintextSize: prepared.prepared.bytes.length,
    };
  } finally {
    attachmentKey.fill(0);
    kemMessage.fill(0);
  }
}
