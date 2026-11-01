import { describe, expect, it } from "vitest";
import { sniffImageFormat, sniffSourceFormat } from "./codec.js";
import { prepareImage } from "./prepare.js";
import { FakeCodec, fakeSourceImage } from "./test-helpers.js";

/**
 * Source (picker/camera) formats vs received formats. iPhone camera photos
 * are HEIC; the picker passes them through untouched and the platform codec
 * (ImageIO / BitmapFactory API 28+) decodes them. Only the INPUT gate accepts
 * HEIF — a received plaintext is always our own JPEG/WebP re-encode, so the
 * receive-side sniffer must keep rejecting it.
 */

const ASCII = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** ISO-BMFF `ftyp` box with the given major brand, then FakeCodec's w,h header. */
function ftypImage(brand: string, width = 400, height = 300): Uint8Array {
  return new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x18,
    ...ASCII("ftyp"),
    ...ASCII(brand),
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    ...ASCII("mif1heic"),
  ]);
}

describe("sniffSourceFormat (input gate)", () => {
  it("accepts the receive-side formats unchanged", () => {
    expect(sniffSourceFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffSourceFormat(fakeSourceImage(10, 10))).toBe("webp");
  });

  it.each(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"])(
    "recognises HEIF major brand %s",
    (brand) => {
      expect(sniffSourceFormat(ftypImage(brand))).toBe("heif");
    },
  );

  it.each(["isom", "mp42", "avif", "qt  "])("rejects non-HEIF ftyp brand %s", (brand) => {
    expect(sniffSourceFormat(ftypImage(brand))).toBe("unknown");
  });

  it("rejects a truncated ftyp header", () => {
    expect(sniffSourceFormat(ftypImage("heic").slice(0, 11))).toBe("unknown");
  });
});

describe("sniffImageFormat (receive gate) stays narrow", () => {
  it("does not accept HEIF plaintext", () => {
    expect(sniffImageFormat(ftypImage("heic"))).toBe("unknown");
  });
});

describe("prepareImage source gate", () => {
  it("prepares an iPhone HEIC source into the requested output format", async () => {
    const prepared = await prepareImage(new FakeCodec(), ftypImage("heic", 400, 300));
    expect(prepared.mimeType).toBe("image/webp");
    expect(sniffImageFormat(prepared.bytes)).toBe("webp");
  });

  it("still rejects bytes that are no image at all", async () => {
    await expect(prepareImage(new FakeCodec(), new Uint8Array(64).fill(7))).rejects.toThrow(
      "prepareImage: unsupported or corrupt image data",
    );
  });
});
