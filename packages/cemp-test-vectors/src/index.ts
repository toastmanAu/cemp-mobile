/**
 * Golden test-vector corpus (spec Phase 1 tasks 8–9).
 *
 * The `vectors/` directory holds language-neutral JSON vectors. Every
 * implementation (TypeScript here, Rust in contracts/ and the future vault)
 * must produce identical results for these inputs (Phase 1 exit criterion:
 * "Identical vectors pass in all implementations").
 */

export const VECTOR_FORMAT_VERSION = 1;

// The typed suite registry + platform-neutral loaders (Phase 12 task 6) —
// the single conformance entry point for every runtime.
export * from "./suites.js";
