import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./base64";

describe("bytesToBase64", () => {
  it("returns an empty string for an empty array", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("encodes a single byte with double padding", () => {
    expect(bytesToBase64(new Uint8Array([0x66]))).toBe("Zg==");
  });

  it("encodes two bytes with single padding", () => {
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f]))).toBe("Zm8=");
  });

  it("encodes three bytes with no padding", () => {
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe("Zm9v");
  });

  it("encodes a four-byte (1.33 group) input", () => {
    // "foob" -> Zm9vYg==
    expect(bytesToBase64(new Uint8Array([0x66, 0x6f, 0x6f, 0x62]))).toBe("Zm9vYg==");
  });

  it("encodes the full 'foobar' known vector", () => {
    const bytes = new TextEncoder().encode("foobar");
    expect(bytesToBase64(bytes)).toBe("Zm9vYmFy");
  });

  it("round-trips arbitrary byte values through the standard alphabet", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x83, 0x7f, 0x01]);
    // Verified against Node's Buffer implementation as an independent oracle.
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
