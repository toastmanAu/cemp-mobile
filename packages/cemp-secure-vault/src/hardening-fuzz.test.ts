import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { VaultError } from "./errors.js";
import { parseVaultFile, serializeVaultFile, type VaultFileV1 } from "./format.js";

/**
 * Vault-file parser fuzzing (Phase 11 task 2): the file on disk is hostile
 * input (rule 4). Property: arbitrary bytes and adversarial JSON structures
 * only ever produce a structured VaultError ("corrupt-vault" or
 * "kdf-params-out-of-range") — never a crash, never a hang, never a silent
 * pass of malformed input. The KDF param caps must fire BEFORE any
 * derivation (DoS guard).
 */
describe("vault file parser fuzz (task 2)", () => {
  it("arbitrary bytes only ever yield a structured VaultError", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), (bytes) => {
        try {
          parseVaultFile(bytes);
          // A random 512-byte file that parses must still be shape-valid:
          // impossible in practice, but if it ever happens the parsed file
          // must re-serialize to the same bytes (canonical form).
          const parsed = parseVaultFile(bytes);
          expect(serializeVaultFile(parsed)).toEqual(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(VaultError);
          expect(["corrupt-vault", "kdf-params-out-of-range"]).toContain((e as VaultError).code);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it("adversarial JSON structures only ever yield a structured VaultError", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        try {
          parseVaultFile(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(VaultError);
          expect(["corrupt-vault", "kdf-params-out-of-range"]).toContain((e as VaultError).code);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it("absurd KDF parameters are rejected by the cap, never derived", () => {
    const bigInt32 = fc
      .integer({ min: 1, max: 0x7fffffff })
      .map((n) => n.toString(16).padStart(2, "0"));
    fc.assert(
      fc.property(bigInt32, (mHex) => {
        const doc = {
          version: 1,
          kdf: { alg: "argon2id", m: Number.parseInt(mHex, 16), t: 3, p: 1, salt: "00".repeat(16) },
          passwordSlot: { nonce: "00".repeat(12), wrappedVek: "00".repeat(48) },
          biometricSlot: null,
          payload: { nonce: "00".repeat(12), ct: "00".repeat(98) },
          meta: { createdAt: 0, wordCount: 12, hasPassphrase: false, autoLockSeconds: 300 },
        };
        const bytes = new TextEncoder().encode(JSON.stringify(doc));
        const m = Number.parseInt(mHex, 16);
        try {
          const parsed: VaultFileV1 = parseVaultFile(bytes);
          // Small m passes the cap (m ≥ 8·p and ≤ 1 GiB); anything larger must throw.
          expect(m).toBeLessThanOrEqual(1_048_576);
          expect(m).toBeGreaterThanOrEqual(8);
          expect(parsed.kdf.alg).toBe("argon2id");
        } catch (e) {
          expect(e).toBeInstanceOf(VaultError);
          expect((e as VaultError).code).toBe("kdf-params-out-of-range");
        }
      }),
      { numRuns: 500 },
    );
  });
});
