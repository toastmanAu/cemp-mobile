/**
 * Golden-vector tests for the CEMP v1 Molecule codecs (spec §14).
 *
 * Every vector in `packages/cemp-test-vectors/vectors/cemp-v1-serialization.json`
 * must decode and re-encode byte-identically, and `encode(fixture)` must
 * reproduce the vector bytes — this is the tripwire for accidental codec
 * drift (AGENTS.md rule 1: serialization changes require spec, vectors and
 * version to move together).
 */

import { describe, expect, it } from "vitest";
import vectors from "../../../cemp-test-vectors/vectors/cemp-v1-serialization.json";
import { bytesToHex, hexToBytes } from "./codecs.js";
import { CODEC_FIXTURES } from "./fixtures.js";

interface VectorCase {
  name: string;
  structure: string;
  bytes: string;
  canonicalReencode?: string;
}

const cases = vectors.cases as VectorCase[];
const fixturesByName = new Map(CODEC_FIXTURES.map((f) => [f.name, f]));

describe("cemp-v1-serialization golden vectors (spec §14)", () => {
  it("vector envelope matches the expected suite and covers every fixture", () => {
    expect(vectors.vectorFormatVersion).toBe(1);
    expect(vectors.suite).toBe("cemp-v1-serialization");
    expect(vectors.source).toContain("cemp-v1.mol");
    expect(cases.length).toBe(CODEC_FIXTURES.length);
    for (const fixture of CODEC_FIXTURES) {
      expect(
        cases.some((c) => c.name === fixture.name),
        `fixture ${fixture.name} is missing from the golden vectors`,
      ).toBe(true);
    }
  });

  for (const c of cases) {
    it(`${c.name} (${c.structure}) round-trips byte-identically`, () => {
      const fixture = fixturesByName.get(c.name);
      if (!fixture) throw new Error(`no fixture registered for vector case ${c.name}`);
      expect(fixture.structure).toBe(c.structure);

      const bytes = hexToBytes(c.bytes);

      // The vector decodes to exactly the fixture value…
      const decoded = fixture.decode(bytes);
      expect(decoded).toEqual(fixture.value);

      // …and re-encodes to the vector bytes (canonical round-trip).
      expect(bytesToHex(fixture.encode(decoded))).toBe(c.bytes);

      // encode(fixture) equals the vector bytes — guards accidental codec drift.
      expect(bytesToHex(fixture.encode(fixture.value))).toBe(c.bytes);

      // Payload cases additionally pin the canonical re-encode explicitly.
      if (c.structure === "CempPayloadV1") {
        expect(c.canonicalReencode).toBe(c.bytes);
      }
    });
  }
});
