/**
 * Malformed-input property tests (spec §12, §14: "Fuzz-style malformed inputs
 * (truncations, offset corruption, oversized declarations) MUST fail safely —
 * property-tested, not just examples").
 *
 * For every structure's valid encoding:
 *  (a) arbitrary truncations MUST throw a CempCodecError;
 *  (b) arbitrary byte flips MUST either throw a CempCodecError or decode to a
 *      value whose canonical re-encode equals the mutated bytes exactly;
 *  (c) arbitrary garbage Uint8Arrays behave the same way at every decode
 *      entry point;
 *  (d) validation APIs never throw — they always return a ValidationResult.
 *
 * No crashes, no exceptions escaping validation, no process hangs.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bytesToHex, CempCodecError, encodeOutPointVec, decodeOutPointVec } from "./codecs.js";
import {
  buildEnvelope,
  buildPayloadText,
  buildProfileMinimal,
  CODEC_FIXTURES,
} from "./fixtures.js";
import { encodeCempEnvelopeV1, encodeCempPayloadV1, encodeCempProfileV1 } from "./codecs.js";
import {
  validateEnvelope,
  validatePayload,
  validateProfile,
  validateSemanticConsistency,
} from "./validate.js";

const TRUNCATION_RUNS = { numRuns: 150 };
const FLIP_RUNS = { numRuns: 200 };
const GARBAGE_RUNS = { numRuns: 150 };

function flipOneByte(valid: Uint8Array, index: number, mask: number): Uint8Array {
  const mutated = Uint8Array.from(valid);
  mutated[index] = (mutated[index] ?? 0) ^ mask;
  return mutated;
}

describe("malformed-input properties per structure (spec §12, §14)", () => {
  for (const fixture of CODEC_FIXTURES) {
    const valid = fixture.encode(fixture.value);

    describe(`${fixture.name} (${fixture.structure}, ${valid.byteLength} B)`, () => {
      it("(a) every truncation fails with CempCodecError", () => {
        fc.assert(
          fc.property(fc.integer({ min: 0, max: valid.byteLength - 1 }), (length) => {
            expect(() => fixture.decode(valid.subarray(0, length))).toThrow(CempCodecError);
          }),
          TRUNCATION_RUNS,
        );
      });

      it("(b) byte flips fail cleanly or round-trip canonically", () => {
        fc.assert(
          fc.property(
            fc.integer({ min: 0, max: valid.byteLength - 1 }),
            fc.integer({ min: 1, max: 0xff }),
            (index, mask) => {
              const mutated = flipOneByte(valid, index, mask);
              let decoded: unknown;
              try {
                decoded = fixture.decode(mutated);
              } catch (e) {
                expect(e).toBeInstanceOf(CempCodecError);
                return;
              }
              // Decode succeeded ⇒ the mutated input must be exactly the
              // canonical encoding of the decoded value (spec §12.1).
              expect(bytesToHex(fixture.encode(decoded))).toBe(bytesToHex(mutated));
            },
          ),
          FLIP_RUNS,
        );
      });

      it("(c) arbitrary garbage fails cleanly or round-trips canonically", () => {
        fc.assert(
          fc.property(fc.uint8Array({ minLength: 0, maxLength: valid.byteLength + 64 }), (data) => {
            try {
              const decoded = fixture.decode(data);
              expect(bytesToHex(fixture.encode(decoded))).toBe(bytesToHex(data));
            } catch (e) {
              expect(e).toBeInstanceOf(CempCodecError);
            }
          }),
          GARBAGE_RUNS,
        );
      });
    });
  }
});

describe("oversized declarations fail safely (spec §14)", () => {
  it("a corrupted dynvec first-offset is rejected immediately, not allocated", () => {
    const valid = encodeOutPointVec([{ tx_hash: new Uint8Array(32).fill(1), index: 1 }]);
    const hostile = Uint8Array.from(valid);
    hostile[7] = 0xff; // first-offset MSB: itemCount ≈ 1e9 without the guard
    expect(() => decodeOutPointVec(hostile)).toThrow(CempCodecError);
  });

  it("corrupted nested dynvec headers inside any structure stay clean", () => {
    // Flip bytes inside the offset-table region of every fixture; must never
    // hang and never throw anything but CempCodecError.
    for (const fixture of CODEC_FIXTURES) {
      const valid = fixture.encode(fixture.value);
      const region = Math.min(valid.byteLength, 64);
      for (let index = 0; index < region; index++) {
        for (const mask of [0x01, 0x80, 0xff]) {
          const mutated = flipOneByte(valid, index, mask);
          try {
            const decoded = fixture.decode(mutated);
            expect(bytesToHex(fixture.encode(decoded))).toBe(bytesToHex(mutated));
          } catch (e) {
            expect(e).toBeInstanceOf(CempCodecError);
          }
        }
      }
    }
  });
});

describe("validation APIs never throw (spec §12)", () => {
  it("(d) arbitrary garbage yields a ValidationResult at every entry point", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 4096 }), (data) => {
        for (const validate of [validateProfile, validateEnvelope, validatePayload]) {
          const result = validate(data);
          expect(typeof result.ok).toBe("boolean");
          if (!result.ok) expect(typeof result.reason).toBe("string");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("(d) oversized envelope garbage hits the pre-decode size gate", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 82_001, maxLength: 82_500 }), (data) => {
        const result = validateEnvelope(data);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/exceeds the 82000-byte limit/);
      }),
      { numRuns: 25 },
    );
  });

  it("(d) mutated valid encodings yield clean validation results", () => {
    const entries = [
      { validate: validateEnvelope, valid: encodeCempEnvelopeV1(buildEnvelope(false)) },
      { validate: validateProfile, valid: encodeCempProfileV1(buildProfileMinimal()) },
      { validate: validatePayload, valid: encodeCempPayloadV1(buildPayloadText()) },
    ] as const;
    for (const { validate, valid } of entries) {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: valid.byteLength - 1 }),
          fc.integer({ min: 1, max: 0xff }),
          (index, mask) => {
            const result = validate(flipOneByte(valid, index, mask));
            expect(typeof result.ok).toBe("boolean");
            if (!result.ok) expect(typeof result.reason).toBe("string");
          },
        ),
        { numRuns: 150 },
      );
    }
  });

  it("(d) semantic consistency never throws on arbitrary own profile ids", () => {
    const header = buildEnvelope(false).header;
    const payload = buildPayloadText();
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (ownProfileId) => {
        const result = validateSemanticConsistency(header, payload, ownProfileId);
        expect(typeof result.ok).toBe("boolean");
        if (!result.ok) expect(typeof result.reason).toBe("string");
      }),
      { numRuns: 100 },
    );
  });
});
