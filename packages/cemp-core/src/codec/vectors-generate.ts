/**
 * Golden-vector generator for CEMP v1 serialization (spec §14).
 *
 * Node-only developer script — never imported by library code. Run:
 *
 *   pnpm --filter @cemp/core exec tsx src/codec/vectors-generate.ts
 *
 * Writes `packages/cemp-test-vectors/vectors/cemp-v1-serialization.json`.
 * Fully deterministic: regenerating MUST produce byte-identical output
 * (AGENTS.md rule 1 — any drift means the codec or the schema changed, and
 * the spec, schema, vectors and serialization version must move together).
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "./codecs.js";
import { CODEC_FIXTURES } from "./fixtures.js";

interface VectorCase {
  name: string;
  structure: string;
  bytes: string;
  /** Present for CempPayloadV1 cases: decode(bytes) → canonical re-encode. */
  canonicalReencode?: string;
}

const cases: VectorCase[] = CODEC_FIXTURES.map((fixture) => {
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
