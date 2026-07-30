import { describe, expect, it } from "vitest";
import { qrMatrix } from "./matrix.js";

describe("qrMatrix", () => {
  it("produces a square matrix whose size matches the module count", () => {
    const m = qrMatrix("HELLO");
    expect(m.size).toBeGreaterThan(0);
    expect(m.dark).toHaveLength(m.size * m.size);
  });

  it("sets the three finder patterns dark at the corners", () => {
    const m = qrMatrix("HELLO");
    const at = (r: number, c: number) => m.dark[r * m.size + c];
    // Finder pattern outer ring corners: top-left, top-right, bottom-left.
    expect(at(0, 0)).toBe(true);
    expect(at(0, m.size - 1)).toBe(true);
    expect(at(m.size - 1, 0)).toBe(true);
    // Bottom-right has no finder pattern.
    expect(at(m.size - 1, m.size - 1)).toBe(false);
  });

  it("is deterministic for the same input", () => {
    expect(qrMatrix("cemp").dark).toEqual(qrMatrix("cemp").dark);
  });

  it("handles a realistic contact bundle payload", () => {
    // 427 chars — measured from real field widths: address is a bech32m
    // ckt1… string over 1+32+1+37 = 71 bytes (MLDSA_V2_SIZES.lockArgs = 37,
    // packages/cemp-crypto/src/mldsa-v2.ts) = 124 chars; fingerprint is 8
    // groups of 4 hex chars (FINGERPRINT_BYTES = 16, fingerprint.ts) = 39
    // chars. This is the payload size that actually ships, encoded at ECC M
    // as an 81x81 (version 16) matrix — exact, so a future payload change
    // that pushes the QR into a new version is caught here, not in the
    // field.
    const payload = JSON.stringify({
      protocol: "cemp-contact",
      version: 1,
      network: "ckb_testnet",
      profileTypeId: `0x${"ab".repeat(32)}`,
      lockScriptHash: `0x${"cd".repeat(32)}`,
      address: `ckt1${"q".repeat(120)}`,
      fingerprint: "AB12-CD34-EF56-1234-5678-9ABC-DEF0-1122",
    });
    const m = qrMatrix(payload);
    expect(m.size).toBe(81);
    expect(m.dark).toHaveLength(m.size * m.size);
  });

  it("rejects an empty payload", () => {
    expect(() => qrMatrix("")).toThrow(/empty/i);
  });

  it("rejects non-ASCII input, naming the Latin-1 encoder as the reason", () => {
    // qrcode-generator's byte encoder is `charCodeAt(i) & 0xff` (Latin-1),
    // not UTF-8: passing this through would silently truncate to garbage
    // that still scans, rather than failing loudly.
    expect(() => qrMatrix("héllo")).toThrow(/ascii/i);
    expect(() => qrMatrix("héllo")).toThrow(/latin-1|utf-8/i);
  });

  it("wraps a qrcode-generator failure as a real Error with a usable message", () => {
    // qrcode-generator throws bare strings (e.g. "code length overflow.") on
    // oversized payloads, not Error objects — `catch (e) { e.message }`
    // would otherwise silently see `undefined`.
    const oversized = "A".repeat(5000);
    let caught: unknown;
    try {
      qrMatrix(oversized);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.length).toBeGreaterThan(0);
  });
});
