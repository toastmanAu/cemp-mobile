import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Platform-boundary enforcement (spec Phase 12 task 1 + AGENTS.md).
 *
 * Shared packages must stay platform-neutral: no `node:*` imports outside the
 * declared `./node` subpath modules (Node reference implementations for
 * tests/tooling), and no React Native imports anywhere — platform code lives
 * in apps/* behind the rule-14 interfaces. This test walks every shared
 * package's sources and fails on any violation, mechanically enforcing the
 * boundary the iOS port depends on.
 */

const REPO_ROOT = join(__dirname, "../../..");
const SHARED_PACKAGES = [
  "cemp-core",
  "cemp-ckb",
  "cemp-crypto",
  "cemp-database",
  "cemp-secure-vault",
  "cemp-ui",
  "cemp-sync",
  "cemp-images",
];

/** Files allowed to import node:* — the ./node subpath backends + tests. */
function isNodeOnlyModule(relPath: string): boolean {
  return (
    /(^|\/)node\.ts$/.test(relPath) ||
    /\.test\.ts$/.test(relPath) ||
    /vectors-generate\.ts$/.test(relPath)
  );
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry !== "dist" && entry !== "node_modules") {
        yield* walk(full);
      }
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of SHARED_PACKAGES) {
    const srcDir = join(REPO_ROOT, "packages", pkg, "src");
    for (const file of walk(srcDir)) {
      const rel = relative(REPO_ROOT, file);
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        const text = line.trim();
        if (/(from|require\()\s*["']react-native["']/.test(text)) {
          violations.push({ file: rel, line: index + 1, text });
        }
        if (/(from|require\()\s*["']node:/.test(text) && !isNodeOnlyModule(rel)) {
          violations.push({ file: rel, line: index + 1, text });
        }
      }
    }
  }
  return violations;
}

describe("platform boundaries (Phase 12 task 1, AGENTS.md)", () => {
  it("no react-native imports in shared packages", () => {
    const violations = findViolations().filter((v) => v.text.includes("react-native"));
    expect(violations).toEqual([]);
  });

  it("no node:* imports outside ./node subpath modules and tests", () => {
    const violations = findViolations().filter((v) => v.text.includes("node:"));
    expect(violations).toEqual([]);
  });

  it("every shared package has a package root that Hermes can load", () => {
    // The package root (index.ts) of every shared package must not import a
    // node-only module — the RN bundle pulls the root, not the subpaths.
    for (const pkg of SHARED_PACKAGES) {
      const indexPath = join(REPO_ROOT, "packages", pkg, "src", "index.ts");
      const content = readFileSync(indexPath, "utf8");
      expect(content, `${pkg}/src/index.ts must not reference the node subpath`).not.toMatch(
        /from\s+["']\.\/node/,
      );
    }
  });
});
