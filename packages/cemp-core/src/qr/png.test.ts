import { describe, expect, it } from "vitest";
import { encodeGreyscalePng } from "./png.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

describe("encodeGreyscalePng", () => {
  it("starts with the PNG signature", () => {
    const png = encodeGreyscalePng(new Uint8Array(4), 2, 2);
    expect([...png.slice(0, 8)]).toEqual(SIGNATURE);
  });

  it("writes IHDR with the given dimensions, 8-bit greyscale", () => {
    const png = encodeGreyscalePng(new Uint8Array(6), 3, 2);
    // 8 signature + 4 length + 4 type = IHDR data starts at 16.
    expect(String.fromCharCode(...png.slice(12, 16))).toBe("IHDR");
    expect(readU32(png, 16)).toBe(3);
    expect(readU32(png, 20)).toBe(2);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(0); // colour type 0 = greyscale
  });

  it("ends with IEND", () => {
    const png = encodeGreyscalePng(new Uint8Array(1), 1, 1);
    expect(String.fromCharCode(...png.slice(png.length - 8, png.length - 4))).toBe("IEND");
  });

  it("rejects a pixel buffer that does not match the dimensions", () => {
    expect(() => encodeGreyscalePng(new Uint8Array(3), 2, 2)).toThrow(/length/i);
  });

  it("rejects zero dimensions", () => {
    expect(() => encodeGreyscalePng(new Uint8Array(0), 0, 0)).toThrow(/dimension/i);
  });

  it("produces output an independent decoder accepts", async () => {
    // sharp is a devDependency of this package for exactly this check.
    const { default: sharp } = await import("sharp");
    const pixels = new Uint8Array([0, 255, 255, 0]);
    const png = encodeGreyscalePng(pixels, 2, 2);
    const meta = await sharp(Buffer.from(png)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(2);
    // Verify the PNG encodes as greyscale (1 channel, b-w color space).
    // This catches IHDR colour-type regressions before sharp converts it.
    expect(meta.channels).toBe(1);
    expect(meta.space).toBe("b-w");
    // sharp.grayscale() ensures the image stays in greyscale format before extracting raw bytes
    const raw = await sharp(Buffer.from(png)).grayscale().raw().toBuffer();
    expect([...raw]).toEqual([0, 255, 255, 0]);
  });

  it("handles multi-block deflate streams for large images", async () => {
    // zlibStored splits data into MAX_STORED_BLOCK (65535 byte) chunks.
    // An image with raw size > 65535 bytes tests the multi-block path.
    // raw size = (width + 1) * height (filter byte per scanline).
    // Use 300 × 230 → (300 + 1) × 230 = 69,230 bytes > 65,535.
    const { default: sharp } = await import("sharp");
    const width = 300;
    const height = 230;
    const pixelCount = width * height;

    // Create alternating pattern: checkerboard-like for visual variety in test.
    const pixels = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      pixels[i] = (i % 2) * 255; // alternates 0, 255, 0, 255, ...
    }

    const png = encodeGreyscalePng(pixels, width, height);

    // Verify metadata.
    const meta = await sharp(Buffer.from(png)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(width);
    expect(meta.height).toBe(height);
    expect(meta.channels).toBe(1);
    expect(meta.space).toBe("b-w");

    // Verify pixel round-trip: decode and check the original pattern.
    const raw = await sharp(Buffer.from(png)).grayscale().raw().toBuffer();
    expect(raw.length).toBe(pixelCount);
    expect([...raw]).toEqual([...pixels]);
  });
});
