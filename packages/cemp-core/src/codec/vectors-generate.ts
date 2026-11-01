/**
 * Golden-vector generator for CEMP v1 serialization (spec §14).
 *
 * Node-only developer script — never imported by library code. Run:
 *
 *   pnpm --filter @cemp/core exec tsx src/codec/vectors-generate.ts
 *
 * Writes `packages/cemp-test-vectors/vectors/cemp-v1-serialization.json` and,
 * for protocol version 2 (ADR 0006), `cemp-v2-serialization.json`. The v1
 * file is historical and MUST stay byte-identical.
 * Fully deterministic: regenerating MUST produce byte-identical output
 * (AGENTS.md rule 1 — any drift means the codec or the schema changed, and
 * the spec, schema, vectors and serialization version must move together).
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "./codecs.js";
import { CODEC_FIXTURES, type FixtureEntry } from "./fixtures.js";
import { CODEC_FIXTURES_V2 } from "./fixtures-v2.js";

interface VectorCase {
  name: string;
  structure: string;
  bytes: string;
  /** Present for CempPayloadV1 cases: decode(bytes) → canonical re-encode. */
  canonicalReencode?: string;
}

function toCases(fixtures: readonly FixtureEntry[]): VectorCase[] {
  return fixtures.map((fixture) => {
    const bytes = fixture.encode(fixture.value);
    const decoded = fixture.decode(bytes);
    const reencoded = fixture.encode(decoded);
    if (bytesToHex(reencoded) !== bytesToHex(bytes)) {
      throw new Error(`fixture ${fixture.name} does not round-trip; refusing to write vectors`);
    }
    const entry: VectorCase = {
      name: fixture.name,
      structure: fixture.structure,
      bytes: bytesToHex(bytes),
    };
    if (fixture.structure === "CempPayloadV1") {
      entry.canonicalReencode = bytesToHex(reencoded);
    }
    return entry;
  });
}

const cases = toCases(CODEC_FIXTURES);
const casesV2 = toCases(CODEC_FIXTURES_V2);

const document = {
  vectorFormatVersion: 1,
  suite: "cemp-v1-serialization",
  source:
    "packages/cemp-core/src/codec/vectors-generate.ts (deterministic fixtures; " +
    "@ckb-ccc/core 1.12.5 Molecule codecs; schema packages/cemp-core/schemas/cemp-v1.mol)",
  cases,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../../cemp-test-vectors/vectors/cemp-v1-serialization.json");
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${outPath}`);

const documentV2 = {
  vectorFormatVersion: 1,
  suite: "cemp-v2-serialization",
  source:
    "packages/cemp-core/src/codec/vectors-generate.ts (deterministic fixtures-v2; " +
    "@ckb-ccc/core 1.12.5 Molecule codecs; schema packages/cemp-core/schemas/cemp-v2.mol " +
    "over cemp-v1.mol; ADR 0006)",
  cases: casesV2,
};
const outPathV2 = resolve(here, "../../../cemp-test-vectors/vectors/cemp-v2-serialization.json");
writeFileSync(outPathV2, `${JSON.stringify(documentV2, null, 2)}\n`);
console.log(`wrote ${casesV2.length} cases to ${outPathV2}`);
