import { describe, expect, it } from "vitest";
import { crc32 } from "./crc32.js";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("crc32", () => {
  it("matches the standard zlib check vector", () => {
    // ASCII "123456789" → 0xCBF43926 (CRC-32/ISO-HDLC catalogue value).
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  });

  it("matches further known vectors and returns unsigned values", () => {
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
    expect(crc32(utf8("a"))).toBe(0xe8b7be43);
    expect(crc32(utf8("abc"))).toBe(0x352441c2);
    expect(crc32(utf8("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
    // 0x80000000-range results must surface as unsigned, never negative.
    expect(crc32(utf8("\x00"))).toBe(0xd202ef8d);
    expect(crc32(utf8("\x00"))).toBeGreaterThan(0);
  });

  it("covers all 256 byte values", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      all[i] = i;
    }
    // Cross-checked against python3 zlib.crc32(bytes(range(256))).
    expect(crc32(all)).toBe(0x29058c73);
  });
});
