/**
 * Client-side image preparation (spec §9.1, Phase 10 tasks 2–6).
 *
 * decode (orientation baked in, metadata dropped) → aspect-preserving resize
 * → progressive re-encode → thumbnail → content hash. The output feeds
 * encrypt.ts; plaintext NEVER leaves the device unencrypted.
 */

import type { ImageCodec, ImageEncodeFormat } from "./codec.js";
import { sniffImageFormat } from "./codec.js";
import { compressToLimits, type CompressResult } from "./compress.js";
import { blake2b256 } from "./encrypt.js";
import { DEFAULT_IMAGE_LIMITS, planThumbnailFit, type ImageLimits } from "./limits.js";

export interface PreparedImage {
  /** Re-encoded, metadata-free, within the byte limit. */
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  /** 320px-edge thumbnail for the chat bubble (also metadata-free). */
  readonly thumbnail: Uint8Array;
  /** blake2b-256 of the PLAINTEXT bytes (the manifest's content_hash). */
  readonly contentHash: Uint8Array;
  readonly compress: CompressResult;
}

const FORMAT_TO_MIME: Record<ImageEncodeFormat, string> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
};

/** The manifest's estimated on-chain footprint (task 6, pre-send display). */
export function estimateAttachmentCapacity(
  prepared: PreparedImage,
  chunkBytes: number,
): {
  readonly encryptedBytes: number;
  readonly chunkCount: number;
} {
  const encryptedBytes = prepared.bytes.length + 16; // GCM tag
  return {
    encryptedBytes,
    chunkCount: Math.ceil(encryptedBytes / chunkBytes),
  };
}

/**
 * Full preparation pipeline. `format` defaults to WebP (spec preference);
 * callers pick JPEG for photographic sources. Animated images are out of
 * scope for v1 (spec §9.1) — codecs decode the first frame only.
 */
export async function prepareImage(
  codec: ImageCodec,
  sourceBytes: Uint8Array,
  options: { format?: ImageEncodeFormat; limits?: ImageLimits } = {},
): Promise<PreparedImage> {
  const limits = options.limits ?? DEFAULT_IMAGE_LIMITS;
  const sniffed = sniffImageFormat(sourceBytes);
  if (sniffed === "unknown") {
    throw new Error("prepareImage: unsupported or corrupt image data");
  }
  const format = options.format ?? "webp";
  const decoded = await codec.decode(sourceBytes);
  const compressed = await compressToLimits(codec, decoded, format, limits);

  // Thumbnail from the same decoded source (aspect preserved).
  const thumbFit = planThumbnailFit({ width: decoded.width, height: decoded.height }, limits);
  const thumbImage = await codec.resize(decoded, thumbFit.width, thumbFit.height);
  const thumbnail = await codec.encode(thumbImage, format, 60);

  return {
    bytes: compressed.bytes,
    mimeType: FORMAT_TO_MIME[format],
    width: compressed.dimensions.width,
    height: compressed.dimensions.height,
    thumbnail,
    contentHash: blake2b256(compressed.bytes),
    compress: compressed,
  };
}
