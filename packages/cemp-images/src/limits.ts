/**
 * Image limits + aspect-preserving fit math (spec §9.1, Phase 10 tasks 3, 5).
 *
 * The compressor progressively reduces (1) dimensions, (2) quality, (3)
 * chroma detail — never distorting aspect ratio. Values come from
 * `PROTOCOL_LIMITS` in @cemp/core; this module is the policy on top.
 */

import { PROTOCOL_LIMITS } from "@cemp/core";

export interface ImageLimits {
  readonly maxLongestEdgePx: number;
  readonly preferredLongestEdgePx: number;
  readonly thumbnailLongestEdgePx: number;
  readonly maxAttachmentBytes: number;
  readonly preferredAttachmentBytes: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxLongestEdgePx: PROTOCOL_LIMITS.maxImageLongestEdgePx,
  preferredLongestEdgePx: PROTOCOL_LIMITS.preferredImageLongestEdgePx,
  thumbnailLongestEdgePx: PROTOCOL_LIMITS.thumbnailLongestEdgePx,
  maxAttachmentBytes: PROTOCOL_LIMITS.maxAttachmentBytes,
  preferredAttachmentBytes: PROTOCOL_LIMITS.preferredAttachmentBytes,
};

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Aspect-preserving fit inside `maxLongestEdgePx` (never upscale). Returns
 * the source dimensions when they already fit.
 */
export function planImageFit(source: Dimensions, maxLongestEdgePx: number): Dimensions {
  if (!Number.isInteger(maxLongestEdgePx) || maxLongestEdgePx <= 0) {
    throw new Error(`planImageFit: invalid max edge ${String(maxLongestEdgePx)}`);
  }
  const { width, height } = source;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`planImageFit: invalid source dimensions ${String(width)}x${String(height)}`);
  }
  const longest = Math.max(width, height);
  if (longest <= maxLongestEdgePx) {
    return { width, height };
  }
  const scale = maxLongestEdgePx / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Thumbnail fit (320px longest edge by default). */
export function planThumbnailFit(
  source: Dimensions,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): Dimensions {
  return planImageFit(source, limits.thumbnailLongestEdgePx);
}

/** Whether an encoded size is publishable (task 5). */
export function isWithinByteLimit(
  byteLength: number,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): boolean {
  return byteLength <= limits.maxAttachmentBytes;
}
