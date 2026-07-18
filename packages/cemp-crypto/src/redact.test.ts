import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

/**
 * Log redaction (Phase 11 task 13, rule 2): secrets never reach the log,
 * public identifiers stay useful.
 */
const TREZOR_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon about";

describe("redactSecrets", () => {
  it("masks BIP39 runs (12 and 24 words, and partial runs ≥ 6)", () => {
    // Conservative by design: the adjoining space and trailing "end" (itself a
    // wordlist word) are masked with the run — over-redaction is the safe side.
    expect(redactSecrets(`mnemonic: ${TREZOR_MNEMONIC} end`)).toBe("mnemonic:‹redacted:mnemonic›");
    const sixWords = "abandon abandon abandon abandon abandon abandon";
    expect(redactSecrets(`partial ${sixWords}!`)).toBe("partial‹redacted:mnemonic›");
  });

  it("masks long hex (seeds, secret keys) but keeps tx hashes and ids", () => {
    const seedHex = "ab".repeat(64);
    const skHex = "cd".repeat(4032);
    const txHash = `0x${"ef".repeat(32)}`;
    const profileId = "12".repeat(32);
    expect(redactSecrets(`seed=${seedHex}`)).toBe("seed=‹redacted:hex›");
    expect(redactSecrets(`sk=0x${skHex}`)).toBe("sk=‹redacted:hex›");
    // Public identifiers stay — logs must remain debuggable.
    expect(redactSecrets(`committed ${txHash}`)).toBe(`committed ${txHash}`);
    expect(redactSecrets(`profile ${profileId}`)).toBe(`profile ${profileId}`);
  });

  it("leaves ordinary text and mixed content alone", () => {
    expect(redactSecrets("committed in block 21785593 (fee 0.00095463 CKB)")).toBe(
      "committed in block 21785593 (fee 0.00095463 CKB)",
    );
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets("one two three words only")).toBe("one two three words only");
  });
});
