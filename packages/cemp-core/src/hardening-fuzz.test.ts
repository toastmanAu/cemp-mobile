import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeContactBundle,
  encodeContactBundle,
  type ContactBundleV1,
} from "./contact-bundle.js";
import { formatFingerprint, parseFingerprint } from "./fingerprint.js";

/**
 * Parser fuzzing (Phase 11 task 2) for the trust-boundary parsers in
 * cemp-core: contact bundles and fingerprints. Property: no input crashes
 * the process with anything but a structured, expected outcome — a thrown
 * Error with a sane message, or a successful parse. JSON-shaped adversaries
 * are the interesting case (a scanned QR is hostile input, rule 4).
 */
describe("contact bundle fuzz (task 2)", () => {
  it("never crashes on arbitrary strings; rejects are structured", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        try {
          decodeContactBundle(text);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
          expect((e as Error).message.startsWith("contact bundle:")).toBe(true);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it("never crashes on adversarial JSON structures", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        try {
          decodeContactBundle(JSON.stringify(value));
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
          expect((e as Error).message.startsWith("contact bundle:")).toBe(true);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it("round-trips valid bundles through decode(encode(x))", () => {
    const hash32 = fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`);
    fc.assert(
      fc.property(hash32, hash32, (profileTypeId, lockScriptHash) => {
        const bundle: ContactBundleV1 = {
          profileTypeId,
          lockScriptHash,
          address: "ckt1qzexample",
          fingerprint: formatFingerprint({
            profileId: new Uint8Array(32),
            mlDsaPublicKey: new Uint8Array(1952),
            mlKemPublicKey: new Uint8Array(1184),
          }),
          network: "ckb_testnet",
        };
        expect(decodeContactBundle(encodeContactBundle(bundle))).toEqual(bundle);
      }),
      { numRuns: 200 },
    );
  });
});

describe("fingerprint fuzz (task 2)", () => {
  it("parseFingerprint never crashes on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        try {
          const canonical = parseFingerprint(text);
          expect(canonical).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it("round-trips random fingerprints", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (bytes) => {
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        const dashed = hex.match(/.{4}/g)!.join("-").toUpperCase();
        expect(parseFingerprint(dashed)).toBe(dashed);
        expect(parseFingerprint(dashed.toLowerCase().replace(/-/g, ""))).toBe(dashed);
      }),
      { numRuns: 500 },
    );
  });
});
