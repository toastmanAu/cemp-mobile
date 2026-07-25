import { describe, expect, it } from "vitest";
import { decodePickResult } from "./pick-result";

/** Pure hex decoder for photo picker results — no React Native imports, runs under plain vitest. */
describe("decodePickResult", () => {
  it("returns null when user cancels", () => {
    expect(decodePickResult(null)).toBeNull();
  });

  it("decodes hex string to Uint8Array", () => {
    // JPEG magic bytes
    const result = decodePickResult("ffd8ff");
    expect(result).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
  });

  it("handles empty hex string", () => {
    const result = decodePickResult("");
    expect(result).toEqual(new Uint8Array(0));
  });

  it("decodes longer hex sequences", () => {
    // 4-byte sequence
    const result = decodePickResult("89504e47");
    expect(result).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });
});
