/**
 * Image send orchestration core (spec §4 decision 5A) — the unit-testable
 * heart of `MessagingService.publishImage`. Deliberately free of
 * react-native imports so it can be exercised directly under vitest with
 * fakes (Task 6 lesson: any module that imports react-native, even
 * transitively, even for an unused export, crashes the test run before a
 * single test executes).
 *
 * Runs the capacity pre-flight BEFORE any publish: prepares the image once
 * to learn its real (post-compression) chunk count, sizes the conservative
 * upper-bound capacity estimate off that, and refuses an under-funded send
 * with a jargon-free error — no stranded pending row, no wasted publish
 * attempt against a wallet that cannot cover it. The SAME prepared image is
 * then threaded into the publish step, so the image is compressed exactly
 * once per send.
 */
import { codec } from "@cemp/core";
import type { AttachmentRepository } from "@cemp/database";
import {
  ATTACHMENT_CHUNK_BYTES,
  ImageTooLargeError,
  estimateAttachmentCapacity,
  estimateImageSendShannon,
  hasSufficientCapacity,
  prepareImage,
  type ImageCodec,
  type PreparedImage,
  type PublishImageMessageInput,
  type PublishImageMessageResult,
} from "@cemp/images";

export interface RunImageSendDeps {
  /**
   * Wraps the platform codec — a `HandleTracker` around `NativeImageCodec`
   * in production, a pure fake in tests. `runImageSend` prepares the image
   * through it once (for the pre-flight) and threads the result into
   * `deps.publish`, so every native handle is released by the one
   * `releaseAll()` in `MessagingService.publishImage`.
   */
  readonly codec: ImageCodec;
  readonly availableShannon: bigint;
  readonly perChunkShannon: bigint;
  readonly messageCellShannon: bigint;
  readonly feeReserveShannon: bigint;
  /** Wraps `publishImageMessage` with the real chain deps (or a test spy). */
  readonly publish: (input: PublishImageMessageInput) => Promise<PublishImageMessageResult>;
  readonly attachments: Pick<AttachmentRepository, "create">;
}

export interface RunImageSendResult {
  readonly messageTxHash: string;
  readonly chunksTxHash: string;
}

/**
 * Prepare once → capacity-gate → publish with the SAME prepared image
 * (`preparedImage` input), so the compression pipeline runs exactly once
 * per send.
 */
export async function runImageSend(
  deps: RunImageSendDeps,
  input: PublishImageMessageInput,
): Promise<RunImageSendResult> {
  let prepared: PreparedImage;
  try {
    prepared = await prepareImage(
      deps.codec,
      input.sourceBytes,
      input.format === undefined ? {} : { format: input.format },
    );
  } catch (error) {
    if (error instanceof ImageTooLargeError) {
      throw new Error("This photo's too large to send. Try a smaller one.", { cause: error });
    }
    throw error;
  }
  const chunkCount = estimateAttachmentCapacity(prepared, ATTACHMENT_CHUNK_BYTES).chunkCount;

  const required = estimateImageSendShannon({
    chunkCount,
    perChunkShannon: deps.perChunkShannon,
    messageCellShannon: deps.messageCellShannon,
    feeReserveShannon: deps.feeReserveShannon,
  });
  if (!hasSufficientCapacity(deps.availableShannon, required)) {
    throw new Error("Not enough balance to send this image.");
  }

  const result = await deps.publish({ ...input, preparedImage: prepared });
  await deps.attachments.create({
    messageId: input.messageRowId,
    kind: "image",
    byteLength: result.plaintextSize,
    manifest: codec.encodeAttachmentManifestV1(result.manifest),
  });
  return { messageTxHash: result.messageTxHash, chunksTxHash: result.chunksTxHash };
}
