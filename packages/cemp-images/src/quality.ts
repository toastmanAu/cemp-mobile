/**
 * Send-quality presets: the user-facing cost knob over the compressor.
 *
 * On-chain storage locks ~1 CKB per byte, and attachments are stored as
 * 32 KiB ciphertext chunks, so every chunk the image spans costs ~33k CKB
 * of locked capacity (returned on reclaim). The compressor stops at the
 * first encode under `preferredAttachmentBytes`, so that target — not the
 * resize alone — decides the price. Presets only ever TIGHTEN the policy:
 * the protocol hard limits (`maxAttachmentBytes`, `maxLongestEdgePx`) are
 * untouched, so the receive side needs no change.
 */

import { ATTACHMENT_CHUNK_BYTES } from "./encrypt.js";
import { DEFAULT_IMAGE_LIMITS, type ImageLimits } from "./limits.js";

export const IMAGE_QUALITIES = ["economy", "standard", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/** Local settings key holding the chosen preset (device-local, never synced). */
export const IMAGE_QUALITY_SETTING_KEY = "images.sendQuality";

export const DEFAULT_IMAGE_QUALITY: ImageQuality = "standard";

/** AES-GCM appends a 16-byte tag before chunking (see encrypt.ts). */
const GCM_TAG_BYTES = 16;

/** Largest plaintext that still encrypts into exactly `chunks` chunks. */
function bytesForChunks(chunks: number): number {
  return chunks * ATTACHMENT_CHUNK_BYTES - GCM_TAG_BYTES;
}

export interface ImageQualityPreset {
  readonly label: string;
  readonly description: string;
  readonly preferredLongestEdgePx: number;
  readonly preferredAttachmentBytes: number;
}

export const IMAGE_QUALITY_PRESETS: Readonly<Record<ImageQuality, ImageQualityPreset>> = {
  economy: {
    label: "Economy",
    description: "Up to 720 px, one chunk. Cheapest to send.",
    preferredLongestEdgePx: 720,
    preferredAttachmentBytes: bytesForChunks(1),
  },
  standard: {
    label: "Standard",
    description: "Up to 960 px, about two chunks. Good for chat.",
    preferredLongestEdgePx: 960,
    preferredAttachmentBytes: bytesForChunks(2),
  },
  high: {
    label: "High",
    description: "Up to 960 px at full quality. Often five chunks or more.",
    preferredLongestEdgePx: DEFAULT_IMAGE_LIMITS.preferredLongestEdgePx,
    preferredAttachmentBytes: DEFAULT_IMAGE_LIMITS.preferredAttachmentBytes,
  },
};

/** Stored value → preset; anything unrecognised falls back to the default. */
export function parseImageQuality(raw: string | null): ImageQuality {
  return (IMAGE_QUALITIES as readonly string[]).includes(raw ?? "")
    ? (raw as ImageQuality)
    : DEFAULT_IMAGE_QUALITY;
}

/** Compressor limits for a preset, layered on the protocol defaults. */
export function limitsForQuality(
  quality: ImageQuality,
  base: ImageLimits = DEFAULT_IMAGE_LIMITS,
): ImageLimits {
  const preset = IMAGE_QUALITY_PRESETS[quality];
  return {
    ...base,
    preferredLongestEdgePx: Math.min(preset.preferredLongestEdgePx, base.maxLongestEdgePx),
    preferredAttachmentBytes: Math.min(preset.preferredAttachmentBytes, base.maxAttachmentBytes),
  };
}
