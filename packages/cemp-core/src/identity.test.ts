import { describe, expect, it } from "vitest";
import { compareBytes, deriveConversationId, deriveRouteTag } from "./identity.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ALICE = new Uint8Array(32).fill(0x11);
const BOB = new Uint8Array(32).fill(0x22);

describe("deriveConversationId (spec §6.3)", () => {
  it("is independent of argument order", () => {
    expect(bytesToHex(deriveConversationId(ALICE, BOB))).toBe(
      bytesToHex(deriveConversationId(BOB, ALICE)),
    );
  });

  it("differs between conversation pairs", () => {
    const carol = new Uint8Array(32).fill(0x33);
    expect(bytesToHex(deriveConversationId(ALICE, BOB))).not.toBe(
      bytesToHex(deriveConversationId(ALICE, carol)),
    );
  });

  it("matches the golden vector", () => {
    expect(bytesToHex(deriveConversationId(ALICE, BOB))).toBe(
      "e33d905879c9df9aa563a76d648d78b807f8caea2f184c5e4db1cf6594133811",
    );
  });
});

describe("deriveRouteTag (spec §6.1)", () => {
  it("rotates with the routing epoch", () => {
    expect(bytesToHex(deriveRouteTag(BOB, 0n))).not.toBe(bytesToHex(deriveRouteTag(BOB, 1n)));
  });

  it("is recipient-specific", () => {
    expect(bytesToHex(deriveRouteTag(ALICE, 0n))).not.toBe(bytesToHex(deriveRouteTag(BOB, 0n)));
  });

  it("matches golden vectors", () => {
    expect(bytesToHex(deriveRouteTag(BOB, 0n))).toBe(
      "323b188372fae91a8430f065c957efb24f5a18971c87887a724959fe24d9763e",
    );
    expect(bytesToHex(deriveRouteTag(BOB, 1n))).toBe(
      "9b5a23ccfccdaf66813297c5195690d806213592d4c1eb8632ea93be1b436dfb",
    );
  });
});

describe("compareBytes", () => {
  it("orders lexicographically", () => {
    expect(compareBytes(hexToBytes("00ff"), hexToBytes("0100"))).toBeLessThan(0);
    expect(compareBytes(hexToBytes("0100"), hexToBytes("00ff"))).toBeGreaterThan(0);
    expect(compareBytes(hexToBytes("abcd"), hexToBytes("abcd"))).toBe(0);
  });

  it("treats shorter prefixes as smaller", () => {
    expect(compareBytes(hexToBytes("aa"), hexToBytes("aabb"))).toBeLessThan(0);
  });
});
