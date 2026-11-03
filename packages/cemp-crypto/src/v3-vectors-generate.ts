/**
 * Golden-vector generator for CEMP protocol v3 envelopes (ADR 0007).
 *
 * Node-only developer script — never imported by library code. Run:
 *
 *   pnpm --filter @cemp/crypto exec tsx src/v3-vectors-generate.ts
 *
 * Writes `packages/cemp-test-vectors/vectors/cemp-v3-envelope.json`. Fully
 * deterministic (fixed seeds, nonce, KEM message, rnd = 0x00*32):
 * regenerating MUST produce byte-identical output. The v1/v2 vector files are
 * not touched by this script.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvelopeV3Vectors } from "./envelope-v3-vectors.js";

const document = buildEnvelopeV3Vectors();
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../cemp-test-vectors/vectors/cemp-v3-envelope.json");
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `wrote ${document.signature.length} signature + ${document.envelope.length} envelope cases to ${outPath}`,
);
