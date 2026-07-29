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

/**
 * Find a module position that genuinely differs from its transpose. A
 * square QR's finder-pattern corners are symmetric under transpose (Task 2
 * review, deferred Minor), so a diagonal or symmetric position can never
 * distinguish a correct row-major render from a transposed one. This
 * searches the real matrix for a position where `dark[row, col]` differs
 * from `dark[col, row]`, so the resulting assertion actually depends on
 * reading rows and columns the right way round.
 */
function findAsymmetricModule(matrix: { size: number; dark: readonly boolean[] }): {
  row: number;
  col: number;
} {
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.dark[row * matrix.size + col] !== matrix.dark[col * matrix.size + row]) {
        return { row, col };
      }
    }
  }
  throw new Error("test fixture: matrix has no asymmetric module to assert against");
}

describe("contactCardPng", () => {
  it("produces a PNG sized from the matrix, module size and quiet zone", async () => {
    const { default: sharp } = await import("sharp");
    const modules = qrMatrix(encodeContactBundle(BUNDLE)).size;
    const quietModules = 4;
    const modulePixels = 8;
    const png = contactCardPng(BUNDLE, { modulePixels, quietModules });

    const expected = (modules + quietModules * 2) * modulePixels;
    const meta = await sharp(Buffer.from(png)).metadata();
    expect(meta.width).toBe(expected);
    expect(meta.height).toBe(expected);
  });

  it("produces a PNG sized correctly for non-default module and quiet-zone sizes", async () => {
    const { default: sharp } = await import("sharp");
    const modules = qrMatrix(encodeContactBundle(BUNDLE)).size;
    const quietModules = 5;
    const modulePixels = 3;
    const png = contactCardPng(BUNDLE, { modulePixels, quietModules });

    const expected = (modules + quietModules * 2) * modulePixels;
    const meta = await sharp(Buffer.from(png)).metadata();
    expect(meta.width).toBe(expected);
    expect(meta.height).toBe(expected);
  });

  it("renders a white quiet zone and a dark top-left finder", async () => {
    const { default: sharp } = await import("sharp");
    const quietModules = 4;
    const modulePixels = 8;
    const png = contactCardPng(BUNDLE, { modulePixels, quietModules });

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
    const x = quietModules * modulePixels + 1;
    const y = quietModules * modulePixels + 1;
    expect(data[y * info.width + x]).toBe(0);
  });

  it("renders row-major: an asymmetric module lands at (row, col), not (col, row)", async () => {
    const { default: sharp } = await import("sharp");
    const quietModules = 4;
    const modulePixels = 8;
    const matrix = qrMatrix(encodeContactBundle(BUNDLE));
    const { row, col } = findAsymmetricModule(matrix);
    const expectedDark = matrix.dark[row * matrix.size + col]!;
    // Sanity check: this position must actually be asymmetric, or the test
    // proves nothing about orientation.
    expect(expectedDark).not.toBe(matrix.dark[col * matrix.size + row]);

    const png = contactCardPng(BUNDLE, { modulePixels, quietModules });
    const { data, info } = await sharp(Buffer.from(png))
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Sample the module center: row -> y, col -> x. A transposed render
    // (row/col swapped in the drawing loop) would sample the OTHER value
    // at this same pixel position, flipping this assertion.
    const x = (col + quietModules) * modulePixels + Math.floor(modulePixels / 2);
    const y = (row + quietModules) * modulePixels + Math.floor(modulePixels / 2);
    const pixel = data[y * info.width + x];
    expect(pixel).toBe(expectedDark ? 0 : 255);
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

  it("rejects a quiet zone below the QR spec minimum of 4 modules", () => {
    expect(() => contactCardPng(BUNDLE, { quietModules: 3 })).toThrow(/quietModules/);
  });
});
