/**
 * Attachment send pipeline (Phase 10 tasks 7–10).
 *
 * Two phases, chain-honest:
 *
 * A) `prepareAttachmentChunks` — local: prepare (resize/re-encode) → encrypt
 *    → chunk. No chain access; everything needed to build the chunk tx.
 *
 * B) `buildManifestForCommittedChunks` — after the chunk tx commits, the
 *    manifest is assembled from the committed outpoints (chunk i = output i
 *    of the single chunk tx) and travels in the message payload
 *    (content_type 0x03) via the Phase 7 publisher.
 *
 * The chunk-tx publish step is {@link publishAttachmentChunks}: journaled
 * before broadcast (rule 6) under purpose `attachment-chunks:<id hex>` so a
 * crash resumes monitoring instead of re-uploading (rule 5).
 */

import { buildDataCellsTx, type CempMessageTypeRef } from "@cemp/ckb";
import { resumeJournaledBroadcast, waitForTransactionCommit } from "@cemp/ckb";
import { cccTransactionToWire, type CempClient } from "@cemp/ckb";
import type { MlDsaV2TxSigner } from "@cemp/ckb";
import { codec } from "@cemp/core";
import { splitIntoChunks, encryptAttachment, type EncryptedAttachment } from "./encrypt.js";
import { buildAttachmentManifest } from "./manifest.js";
import { prepareImage, type PreparedImage } from "./prepare.js";
import type { ImageCodec, ImageEncodeFormat } from "./codec.js";
import type { ImageLimits } from "./limits.js";

export interface PreparedChunks {
  readonly prepared: PreparedImage;
  readonly encrypted: EncryptedAttachment;
  /** The chunk payloads in positional order (ciphertext slices). */
  readonly chunks: readonly Uint8Array[];
}

/** Phase A: prepare → encrypt → chunk (local, no chain). */
export async function prepareAttachmentChunks(
  codecImpl: ImageCodec,
  sourceBytes: Uint8Array,
  attachmentKey: Uint8Array,
  options: { format?: ImageEncodeFormat; limits?: ImageLimits; attachmentId?: Uint8Array } = {},
): Promise<PreparedChunks> {
  const prepared = await prepareImage(codecImpl, sourceBytes, {
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const encrypted = encryptAttachment(
    prepared.bytes,
    attachmentKey,
    options.attachmentId ?? undefined,
  );
  return { prepared, encrypted, chunks: splitIntoChunks(encrypted.ciphertext) };
}

/** Narrow journal boundary for the chunk-tx publish step (rule 6). */
export interface AttachmentChunkJournal {
  recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string | undefined;
    submittedAtMs?: number | undefined;
    capacityShannon?: string | undefined;
    txHex?: string | undefined;
  }): Promise<void>;
  markOutgoingTxState(txHash: string, state: string, committedAtMs?: number): Promise<void>;
  findLatestOutgoingTxByPurposePrefix(
    prefix: string,
  ): Promise<{ txHash: string; state: string; purpose: string; txHex?: string | null } | undefined>;
}

export interface PublishChunksResult {
  readonly chunksTxHash: string;
  readonly chunkCount: number;
  readonly resumed: boolean;
}

/**
 * Publish the chunk cells (one batched tx), journaled before broadcast.
 * Crash-resume: a journaled `attachment-chunks:<id>` tx is monitored to
 * commit instead of re-uploaded (no orphan CKBFS cells, exit criterion).
 */
export async function publishAttachmentChunks(
  deps: {
    client: CempClient;
    signer: MlDsaV2TxSigner;
    journal: AttachmentChunkJournal;
    messageType: CempMessageTypeRef;
  },
  chunks: PreparedChunks,
  options: { timeoutMs?: number } = {},
): Promise<PublishChunksResult> {
  const { client, signer, journal } = deps;
  const purpose = `attachment-chunks:${bytesToHex(chunks.encrypted.attachmentId)}`;

  const journaled = await journal.findLatestOutgoingTxByPurposePrefix(purpose);
  if (journaled !== undefined && journaled.state === "submitted") {
    // Review E1: rebroadcast from the journaled signed bytes if the network
    // never saw the chunk tx (never wedge, never double-upload).
    await resumeJournaledBroadcast(
      client,
      { txHash: journaled.txHash, txHex: journaled.txHex ?? null },
      {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
    );
    await journal.markOutgoingTxState(journaled.txHash, "committed", Date.now());
    return { chunksTxHash: journaled.txHash, chunkCount: chunks.chunks.length, resumed: true };
  }

  const built = await buildDataCellsTx({ datasets: chunks.chunks, signer });
  const signed = await signer.signTransaction(built.tx);
  const txHash = signed.hash();
  const totalCapacity = built.tx.outputs.reduce((sum, output) => sum + output.capacity, 0n);
  // Rule 6: journal BEFORE broadcast, signed bytes included (review E1).
  const wire = cccTransactionToWire(signed);
  await journal.recordOutgoingTx({
    txHash,
    purpose,
    state: "submitted",
    feeShannon: built.estimatedFee.toString(),
    capacityShannon: totalCapacity.toString(),
    txHex: JSON.stringify(wire),
    submittedAtMs: Date.now(),
  });
  const accepted = await client.sendTransaction(wire);
  if (accepted !== txHash) {
    throw new Error("publishAttachmentChunks: node returned a different tx hash");
  }
  await waitForTransactionCommit(client, txHash, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  await journal.markOutgoingTxState(txHash, "committed", Date.now());
  return { chunksTxHash: txHash, chunkCount: chunks.chunks.length, resumed: false };
}

/**
 * Phase B: manifest from committed chunk outpoints (chunk i = output i of
 * `chunksTxHash`). `reclaimGroupId` links message + chunks for the group
 * reclaim (task 14).
 */
export function buildManifestForCommittedChunks(input: {
  readonly chunks: PreparedChunks;
  readonly chunksTxHash: string;
  readonly reclaimGroupId: Uint8Array;
}): codec.AttachmentManifestV1Encodable {
  const { chunks, chunksTxHash } = input;
  return buildAttachmentManifest({
    attachmentId: chunks.encrypted.attachmentId,
    chunkOutpoints: chunks.chunks.map((_, index) => ({ txHash: chunksTxHash, index })),
    encryptedSize: chunks.encrypted.ciphertext.length,
    plaintextSize: chunks.prepared.bytes.length,
    mimeType: chunks.prepared.mimeType,
    width: chunks.prepared.width,
    height: chunks.prepared.height,
    thumbnail: chunks.prepared.thumbnail,
    contentHash: chunks.prepared.contentHash,
    cipherHash: chunks.encrypted.cipherHash,
    encryptionNonce: chunks.encrypted.nonce,
    reclaimGroupId: input.reclaimGroupId,
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
