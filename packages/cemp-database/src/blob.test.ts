import { describe, expect, it } from "vitest";
import { blobToBytes, normalizeBlobCells } from "./blob.js";

describe("blobToBytes", () => {
  it("passes a Uint8Array through", () => {
    const b = new Uint8Array([1, 2, 3]);
    expect(blobToBytes(b)).toBe(b);
  });

  it("converts the op-sqlite ArrayBuffer shape (2026-08-15 device defect)", () => {
    const out = blobToBytes(new Uint8Array([9, 8, 7]).buffer);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out ?? [])).toEqual([9, 8, 7]);
    // The call that threw on device must now work.
    expect(() => out?.fill(0)).not.toThrow();
  });

  it("respects the view window of other ArrayBufferViews", () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4]);
    const view = new DataView(backing.buffer, 1, 3);
    expect(Array.from(blobToBytes(view) ?? [])).toEqual([1, 2, 3]);
  });

  it("maps NULL, empty blobs and non-binary shapes to null", () => {
    expect(blobToBytes(null)).toBeNull();
    expect(blobToBytes(undefined)).toBeNull();
    expect(blobToBytes(new Uint8Array(0))).toBeNull();
    expect(blobToBytes(new ArrayBuffer(0))).toBeNull();
    expect(blobToBytes(42)).toBeNull();
    // Strings are never guessed at: hex is also valid base64.
    expect(blobToBytes("00".repeat(32))).toBeNull();
  });
});

describe("normalizeBlobCells", () => {
  it("converts ArrayBuffer cells, keeps everything else, and is lossless for empty blobs", () => {
    const rows = [
      { id: 1, name: "a", key: new Uint8Array([5, 6]).buffer, empty: new ArrayBuffer(0), n: null },
    ];
    const [out] = normalizeBlobCells(rows);
    expect(out?.id).toBe(1);
    expect(out?.name).toBe("a");
    expect(out?.n).toBeNull();
    expect(out?.key).toBeInstanceOf(Uint8Array);
    expect(Array.from(out?.key as unknown as Uint8Array)).toEqual([5, 6]);
    expect(out?.empty).toBeInstanceOf(Uint8Array);
    expect((out?.empty as unknown as Uint8Array).length).toBe(0);
  });

  it("returns the same row object when nothing needs converting", () => {
    const row = { id: 1, blob: new Uint8Array([1]) };
    expect(normalizeBlobCells([row])[0]).toBe(row);
  });
});
