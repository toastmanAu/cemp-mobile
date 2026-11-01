import { describe, expect, it } from "vitest";
import { ATTACHMENT_CHUNK_BYTES } from "./encrypt.js";
import { DEFAULT_IMAGE_LIMITS } from "./limits.js";
import { estimateAttachmentCapacity, prepareImage } from "./prepare.js";
import {
  DEFAULT_IMAGE_QUALITY,
  IMAGE_QUALITIES,
  IMAGE_QUALITY_PRESETS,
  limitsForQuality,
  parseImageQuality,
} from "./quality.js";
import { FakeCodec, fakeSourceImage } from "./test-helpers.js";

/**
 * On-chain storage locks ~1 CKB per byte, so the send-quality preset is a
 * cost knob. A 12 MP camera photo is the realistic input: under the old
 * single policy it always landed at 960 px q82 (~140 KB → 5 chunks).
 */
const CAMERA_PHOTO = fakeSourceImage(4032, 3024);

async function chunksFor(quality: (typeof IMAGE_QUALITIES)[number]): Promise<number> {
  const prepared = await prepareImage(new FakeCodec(), CAMERA_PHOTO, {
    format: "jpeg",
    limits: limitsForQuality(quality),
  });
  return estimateAttachmentCapacity(prepared, ATTACHMENT_CHUNK_BYTES).chunkCount;
}

describe("image send quality presets", () => {
  it("high keeps the previous behaviour exactly", () => {
    expect(limitsForQuality("high")).toEqual(DEFAULT_IMAGE_LIMITS);
  });

  it("economy fits a camera photo in one chunk, standard in two", async () => {
    expect(await chunksFor("economy")).toBe(1);
    expect(await chunksFor("standard")).toBe(2);
    expect(await chunksFor("high")).toBe(5);
  });

  it("byte targets leave room for the 16-byte GCM tag inside the chunk budget", () => {
    // A target of exactly N×32 KiB would tip into an extra chunk once the
    // tag is appended; the presets must land on a chunk boundary.
    for (const q of ["economy", "standard"] as const) {
      const target = IMAGE_QUALITY_PRESETS[q].preferredAttachmentBytes;
      const chunks = Math.ceil((target + 16) / ATTACHMENT_CHUNK_BYTES);
      expect(Math.ceil(target / ATTACHMENT_CHUNK_BYTES)).toBe(chunks);
    }
  });

  it("never loosens the protocol hard limits", () => {
    for (const q of IMAGE_QUALITIES) {
      const limits = limitsForQuality(q);
      expect(limits.maxAttachmentBytes).toBe(DEFAULT_IMAGE_LIMITS.maxAttachmentBytes);
      expect(limits.maxLongestEdgePx).toBe(DEFAULT_IMAGE_LIMITS.maxLongestEdgePx);
      expect(limits.preferredLongestEdgePx).toBeLessThanOrEqual(limits.maxLongestEdgePx);
      expect(limits.preferredAttachmentBytes).toBeLessThanOrEqual(limits.maxAttachmentBytes);
    }
  });

  it("parses stored values and falls back to the default for anything else", () => {
    expect(parseImageQuality("economy")).toBe("economy");
    expect(parseImageQuality("standard")).toBe("standard");
    expect(parseImageQuality("high")).toBe("high");
    expect(parseImageQuality(null)).toBe(DEFAULT_IMAGE_QUALITY);
    expect(parseImageQuality("")).toBe(DEFAULT_IMAGE_QUALITY);
    expect(parseImageQuality("HIGH")).toBe(DEFAULT_IMAGE_QUALITY);
    expect(parseImageQuality("toString")).toBe(DEFAULT_IMAGE_QUALITY);
  });

  it("defaults to standard", () => {
    expect(DEFAULT_IMAGE_QUALITY).toBe("standard");
  });
});
