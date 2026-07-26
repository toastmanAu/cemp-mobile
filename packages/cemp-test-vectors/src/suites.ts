/**
 * Typed access to the golden-vector suites (spec Phase 12 task 6: shared
 * protocol conformance tests). ONE entry point for every runtime —
 * TypeScript/vitest today, a native iOS conformance runner later — so
 * conformance never depends on relative-path JSON imports scattered across
 * consumer packages.
 *
 * Platform-neutral by construction (rule 14): this module performs no I/O.
 * The caller supplies a {@link VectorFileReader}; Node tooling passes
 * `node:fs.readFileSync`, an on-device runner passes a bundle-asset reader.
 */

import { VECTOR_FORMAT_VERSION } from "./index.js";

export interface VectorSuiteHeader {
  /** Suite id — must equal the JSON's own `suite` field. */
  readonly id: string;
  /** File name within the vectors directory. */
  readonly file: string;
  readonly description: string;
}

/**
 * The conformance corpus. Registry completeness is asserted by
 * `suites.test.ts` (every file in `vectors/` is registered exactly once).
 */
export const VECTOR_SUITES: readonly VectorSuiteHeader[] = [
  {
    id: "cemp-v1-serialization",
    file: "cemp-v1-serialization.json",
    description: "Molecule serialization round-trips (profiles, envelopes, payloads, manifests)",
  },
  {
    id: "cemp-v1-envelope",
    file: "cemp-v1-envelope.json",
    description: "ML-KEM envelope seal/open against fixed identities",
  },
  {
    id: "cemp-vault-v1",
    file: "cemp-vault-v1.json",
    description: "Vault file format v1 (KEK wrap/unwrap, encrypted payload)",
  },
  {
    id: "hkdf-sha256",
    file: "hkdf-sha256.json",
    description: "HKDF-SHA256 (RFC 5869 cases + CEMP domain labels)",
  },
  {
    id: "mldsa-v2-signing",
    file: "mldsa-v2.json",
    description: "ML-DSA-65 v2 CighashAll keygen/sign (Rust harness interop)",
  },
];

export interface LoadedVectorSuite {
  /** The registered id (=== the JSON's `suite` field, verified). */
  readonly id: string;
  /** The JSON's `vectorFormatVersion` (=== VECTOR_FORMAT_VERSION, verified). */
  readonly formatVersion: number;
  /** Provenance string recorded in the vector file. */
  readonly source: string;
  /** The parsed suite JSON, shape per-suite (consumers narrow). */
  readonly json: Record<string, unknown>;
}

/** Reads one file as UTF-8 text. The ONLY I/O in the loading path. */
export type VectorFileReader = (path: string) => string;

function fail(message: string): never {
  throw new Error(`cemp-test-vectors: ${message}`);
}

/** Load + validate one registered suite. Throws on unknown id, unreadable
 * file, malformed JSON, id/version mismatch, or missing case content. */
export function loadVectorSuite(
  id: string,
  readFile: VectorFileReader,
  directory = "vectors",
): LoadedVectorSuite {
  const header = VECTOR_SUITES.find((s) => s.id === id);
  if (header === undefined) {
    fail(`unknown suite "${id}" (known: ${VECTOR_SUITES.map((s) => s.id).join(", ")})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(`${directory}/${header.file}`));
  } catch (error) {
    fail(
      `cannot read/parse ${header.file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${header.file}: top level is not an object`);
  }
  const json = parsed as Record<string, unknown>;
  if (json.suite !== header.id) {
    fail(
      `${header.file}: suite field ${String(json.suite)} does not match registry id ${header.id}`,
    );
  }
  if (json.vectorFormatVersion !== VECTOR_FORMAT_VERSION) {
    fail(
      `${header.file}: vectorFormatVersion ${String(json.vectorFormatVersion)} — this runner speaks ${String(VECTOR_FORMAT_VERSION)} (rule 13: formats are versioned; regenerate or pin the runner)`,
    );
  }
  if (typeof json.source !== "string" || json.source.length === 0) {
    fail(`${header.file}: missing provenance string`);
  }
  // Every suite carries its cases under at least one known key (mldsa-v2
  // splits keygen/sign instead of a single `cases` array).
  const caseKeys = ["cases", "keygen", "sign"] as const;
  const total = caseKeys.reduce((sum, key) => {
    const value = json[key];
    return sum + (Array.isArray(value) ? value.length : 0);
  }, 0);
  if (total === 0) {
    fail(`${header.file}: no vector cases found under cases/keygen/sign`);
  }
  return {
    id: header.id,
    formatVersion: VECTOR_FORMAT_VERSION,
    source: json.source,
    json,
  };
}

/** Load every registered suite, in registry order. */
export function loadAllVectorSuites(
  readFile: VectorFileReader,
  directory = "vectors",
): LoadedVectorSuite[] {
  return VECTOR_SUITES.map((suite) => loadVectorSuite(suite.id, readFile, directory));
}
