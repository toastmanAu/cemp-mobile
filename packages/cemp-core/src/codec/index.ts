/**
 * CEMP v1 Molecule codec module (spec §12–§14).
 *
 * - `codecs.ts` — declarative Molecule codecs, strict encode/decode pairs.
 * - `validate.ts` — spec §12 validation pipeline (total, never throwing).
 * - `fixtures.ts` — deterministic fixtures behind the golden vectors.
 *
 * `vectors-generate.ts` is a Node-only dev script and is intentionally not
 * re-exported here.
 */

export * from "./codecs.js";
export * from "./validate.js";
export * from "./fixtures.js";
