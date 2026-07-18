/**
 * Progressive compression loop (spec §9.1, Phase 10 tasks 3–5).
 *
 * Order of retreat — dimensions first, then quality (chroma detail is a
 * codec-internal concern): try the preferred edge at descending qualities;
 * if nothing lands under the preferred byte target, step the longest edge
 * down and retry. Anything still over the HARD maximum after the final
 * step is rejected (task 5) — it never reaches the chain.
 */

import type { DecodedImage, ImageCodec, ImageEncodeFormat } from "./codec.js";
import { DEFAULT_IMAGE_LIMITS, planImageFit, type Dimensions, type ImageLimits } from "./limits.js";

/** Longest-edge scale factors tried in order (dimensions retreat). */
const EDGE_STEPS = [1.0, 0.8, 0.64, 0.5, 0.36] as const;
/** Quality ladder tried at each dimension step (quality retreat). */
const QUALITY_STEPS = [82, 68, 55, 42] as const;

export interface CompressResult {
  readonly bytes: Uint8Array;
  readonly format: ImageEncodeFormat;
  readonly quality: number;
  readonly dimensions: Dimensions;
  /** True when the preferred byte target was met (vs merely the hard cap). */
  readonly metPreferredTarget: boolean;
}

export class ImageTooLargeError extends Error {
  constructor(smallestBytes: number, maxBytes: number) {
    super(
      `image cannot be compressed below the ${String(maxBytes)}-byte protocol maximum ` +
        `(smallest achieved: ${String(smallestBytes)} bytes)`,
    );
    this.name = "ImageTooLargeError";
  }
}

/**
 * Compress `image` to fit the limits. Aspect ratio is always preserved —
 * dimensions come from `planImageFit` only.
 */
export async function compressToLimits(
  codec: ImageCodec,
  image: DecodedImage,
  format: ImageEncodeFormat,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): Promise<CompressResult> {
  const base = planImageFit(
    { width: image.width, height: image.height },
    limits.preferredLongestEdgePx,
  );
  let smallest: { bytes: Uint8Array; quality: number; dimensions: Dimensions } | null = null;
  for (const edgeScale of EDGE_STEPS) {
    const dimensions: Dimensions = {
      width: Math.max(1, Math.round(base.width * edgeScale)),
      height: Math.max(1, Math.round(base.height * edgeScale)),
    };
    const resized =
      dimensions.width === image.width && dimensions.height === image.height
        ? image
        : await codec.resize(image, dimensions.width, dimensions.height);
    for (const quality of QUALITY_STEPS) {
      const bytes = await codec.encode(resized, format, quality);
      if (smallest === null || bytes.length < smallest.bytes.length) {
        smallest = { bytes, quality, dimensions };
      }
      if (bytes.length <= limits.preferredAttachmentBytes) {
        return { bytes, format, quality, dimensions, metPreferredTarget: true };
      }
    }
  }
  if (smallest !== null && smallest.bytes.length <= limits.maxAttachmentBytes) {
    return {
      bytes: smallest.bytes,
      format,
      quality: smallest.quality,
      dimensions: smallest.dimensions,
      metPreferredTarget: false,
    };
  }
  throw new ImageTooLargeError(
    smallest?.bytes.length ?? Number.POSITIVE_INFINITY,
    limits.maxAttachmentBytes,
  );
}
