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
    // ~260 chars — the real payload size this feature must encode.
    const payload = JSON.stringify({
      protocol: "cemp-contact",
      version: 1,
      network: "ckb_testnet",
      profileTypeId: `0x${"ab".repeat(32)}`,
      lockScriptHash: `0x${"cd".repeat(32)}`,
      address: `ckt1${"q".repeat(95)}`,
      fingerprint: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX",
    });
    const m = qrMatrix(payload);
    expect(m.size).toBeGreaterThanOrEqual(45);
    expect(m.dark).toHaveLength(m.size * m.size);
  });

  it("rejects an empty payload", () => {
    expect(() => qrMatrix("")).toThrow(/empty/i);
  });
});
