import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VECTOR_FORMAT_VERSION } from "./index.js";
import {
  VECTOR_SUITES,
  loadAllVectorSuites,
  loadVectorSuite,
  type VectorFileReader,
} from "./suites.js";

/**
 * Registry + loader conformance (spec Phase 12 task 6). The SEMANTIC vector
 * assertions live in each package's vector tests; this suite guarantees the
 * corpus itself is complete, addressable through one entry point, and
 * version-locked — the properties a second-platform runner relies on.
 */

const vectorsDir = fileURLToPath(new URL("../vectors", import.meta.url));
const nodeReader: VectorFileReader = (path) => readFileSync(path, "utf8");

describe("vector suite registry (Phase 12 task 6)", () => {
  it("registers every file in vectors/ exactly once", () => {
    const onDisk = readdirSync(vectorsDir).filter((f) => f.endsWith(".json"));
    const registered = VECTOR_SUITES.map((s) => s.file);
    expect([...registered].sort()).toEqual([...onDisk].sort());
    expect(new Set(registered).size).toBe(registered.length);
    expect(new Set(VECTOR_SUITES.map((s) => s.id)).size).toBe(VECTOR_SUITES.length);
  });

  it("loads every suite: id, provenance, version lock, non-empty cases", () => {
    const suites = loadAllVectorSuites(nodeReader, vectorsDir);
    expect(suites).toHaveLength(VECTOR_SUITES.length);
    for (const suite of suites) {
      expect(suite.id).toBe(suite.json.suite);
      expect(suite.formatVersion).toBe(VECTOR_FORMAT_VERSION);
      expect(suite.source.length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown suite id", () => {
    expect(() => loadVectorSuite("nope", nodeReader, vectorsDir)).toThrow(/unknown suite/);
  });

  it("rejects a version from the future (rule 13)", () => {
    const futuristic: VectorFileReader = () =>
      JSON.stringify({
        vectorFormatVersion: VECTOR_FORMAT_VERSION + 1,
        suite: "hkdf-sha256",
        source: "test",
        cases: [{}],
      });
    expect(() => loadVectorSuite("hkdf-sha256", futuristic)).toThrow(/vectorFormatVersion/);
  });

  it("rejects an id/file mismatch and an empty suite", () => {
    const mismatched: VectorFileReader = () =>
      JSON.stringify({ vectorFormatVersion: 1, suite: "wrong", source: "test", cases: [{}] });
    expect(() => loadVectorSuite("hkdf-sha256", mismatched)).toThrow(/does not match/);
    const empty: VectorFileReader = () =>
      JSON.stringify({ vectorFormatVersion: 1, suite: "hkdf-sha256", source: "test", cases: [] });
    expect(() => loadVectorSuite("hkdf-sha256", empty)).toThrow(/no vector cases/);
  });
});
