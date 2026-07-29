import { describe, expect, it } from "vitest";
import type { ContactBundleV1 } from "../contact-bundle.js";
import { qrMatrix } from "./matrix.js";
import { contactCardPng } from "./card-image.js";
import { encodeContactBundle } from "../contact-bundle.js";

const BUNDLE: ContactBundleV1 = {
  profileTypeId: `0x${"ab".repeat(32)}`,
  lockScriptHash: `0x${"cd".repeat(32)}`,
  address: `ckt1${"q".repeat(95)}`,
  fingerprint: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX",
  network: "ckb_testnet",
};

describe("contactCardPng", () => {
  it("produces a PNG sized from the matrix, module size and quiet zone", async () => {
    const { default: sharp } = await import("sharp");
    const modules = qrMatrix(encodeContactBundle(BUNDLE)).size;
    const png = contactCardPng(BUNDLE, { modulePixels: 8, quietModules: 4 });

    const expected = (modules + 8) * 8; // quiet zone on both sides
    const meta = await sharp(Buffer.from(png)).metadata();
    expect(meta.width).toBe(expected);
    expect(meta.height).toBe(expected);
  });

  it("renders a white quiet zone and a dark top-left finder", async () => {
    const { default: sharp } = await import("sharp");
    const png = contactCardPng(BUNDLE, { modulePixels: 8, quietModules: 4 });

    // Confirm the PNG is really single-channel greyscale before indexing raw
    // bytes 1:1 per pixel — sharp's .raw() upconverts to RGB unless told
    // .grayscale() first, which would silently misalign every index below
    // (see png.test.ts for the same precaution on the encoder itself).
    const meta = await sharp(Buffer.from(png)).metadata();
    expect(meta.channels).toBe(1);
    expect(meta.space).toBe("b-w");

    const { data, info } = await sharp(Buffer.from(png))
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(data[0]).toBe(255); // top-left corner is quiet zone
    // First module of the finder pattern, inside the quiet zone.
    const x = 4 * 8 + 1;
    const y = 4 * 8 + 1;
    expect(data[y * info.width + x]).toBe(0);
  });

  it("defaults to 8px modules and a 4-module quiet zone", async () => {
    const { default: sharp } = await import("sharp");
    const a = await sharp(Buffer.from(contactCardPng(BUNDLE))).metadata();
    const b = await sharp(
      Buffer.from(contactCardPng(BUNDLE, { modulePixels: 8, quietModules: 4 })),
    ).metadata();
    expect(a.width).toBe(b.width);
  });

  it("rejects a module size below 1", () => {
    expect(() => contactCardPng(BUNDLE, { modulePixels: 0 })).toThrow(/modulePixels/);
  });
});
