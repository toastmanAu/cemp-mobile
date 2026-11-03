/**
 * Cross-runtime check of the v3 envelope vectors (ADR 0007 test plan): the
 * independent Rust implementation in tools/signing-harness (`fips204` 0.4.6,
 * its own Molecule table parser) verifies every signature case, re-signs
 * every known answer deterministically, and rebuilds every accepted
 * envelope's transcript from the wire bytes. Skipped when cargo is absent.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/cemp-v3-envelope.json";
import type { EnvelopeV3VectorFile } from "./envelope-v3-vectors.js";

const file = vectors as EnvelopeV3VectorFile;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const harnessManifest = "tools/signing-harness/Cargo.toml";
const vectorPath = "packages/cemp-test-vectors/vectors/cemp-v3-envelope.json";
const harnessAvailable =
  existsSync(new URL(`../../../${harnessManifest}`, import.meta.url)) &&
  spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;
const CARGO_TIMEOUT_MS = 300_000;

describe("cemp-v3-envelope vectors verified by the Rust fips204 harness", () => {
  it.skipIf(!harnessAvailable)(
    "every case matches its recorded expectation",
    { timeout: CARGO_TIMEOUT_MS },
    () => {
      const res = spawnSync(
        "cargo",
        [
          "run",
          "--quiet",
          "--manifest-path",
          harnessManifest,
          "--",
          "envelope-v3",
          "--vectors",
          vectorPath,
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: CARGO_TIMEOUT_MS },
      );
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      const lines = new Map(
        res.stdout
          .trim()
          .split("\n")
          .map((line) => {
            const [kind, name, ...rest] = line.split(" ");
            return [`${kind!} ${name!}`, rest.join(" ")] as const;
          }),
      );
      for (const c of file.signature) {
        const resign = c.knownAnswer ? "MATCH" : "SKIP";
        expect(lines.get(`signature ${c.name}`)).toBe(
          `verify=${c.expectVerify ? "OK" : "FAIL"} resign=${resign}`,
        );
      }
      for (const c of file.envelope) {
        expect(lines.get(`envelope ${c.name}`)).toBe(
          c.expect === "accept" ? "verify=OK transcript=MATCH" : "verify=SKIP transcript=SKIP",
        );
      }
      expect(lines.size).toBe(file.signature.length + file.envelope.length);
    },
  );
});
