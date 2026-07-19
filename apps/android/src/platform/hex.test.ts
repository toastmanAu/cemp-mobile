import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "./hex";

describe("bytesToHex", () => {
  it("lower-cases and zero-pads each byte", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });

  it("returns an empty string for an empty array", () => {
    expect(bytesToHex(new Uint8Array())).toBe("");
  });
});

describe("hexToBytes", () => {
  it("inverts bytesToHex", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255, 128]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it("returns an empty array for an empty string", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array());
  });
});
