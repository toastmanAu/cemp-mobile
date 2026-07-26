/**
 * Dependency audit gate (CI): fail on high/critical advisories in the
 * workspace's PRODUCTION dependency closure. Replacement for
 * `pnpm audit --prod --audit-level=high`, which started failing on
 * 2026-07-26 when the npm registry began returning gzip-encoded responses
 * that pnpm 10.32.1's fetch path cannot decode ("Unexpected token … is not
 * valid JSON").
 *
 * Semantics: identical to `pnpm audit --prod` — the dependency set is
 * computed by `pnpm ls --prod --recursive --depth=Infinity --json` (the
 * same prod closure, devDependencies excluded), advisories come from the
 * registry's bulk endpoint, and the bar is the same (high+ fails). The only
 * difference is transport: this gate sends `accept-encoding: identity`,
 * sidestepping the pnpm gzip decode bug.
 */

import { execFileSync } from "node:child_process";

const REGISTRY = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org";
const ENDPOINT = `${REGISTRY}/-/npm/v1/security/advisories/bulk`;
const BATCH = 200;
const FAIL_SEVERITIES = new Set(["high", "critical"]);

/** The production dependency closure as name → Set(version), via pnpm itself. */
function prodClosure() {
  const output = execFileSync(
    "pnpm",
    ["ls", "--prod", "--recursive", "--depth=Infinity", "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const found = new Map();
  const add = (name, version) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(version);
  };
  const walk = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (typeof info.version === "string") add(name, info.version);
      walk(info.dependencies);
    }
  };
  for (const importer of JSON.parse(output)) {
    walk(importer.dependencies);
  }
  return found;
}

async function fetchAdvisories(batch) {
  const body = JSON.stringify(Object.fromEntries(batch.map(([n, vs]) => [n, [...vs]])));
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // identity only: the registry's gzip responses break pnpm 10.32.1's
      // audit path; this gate never asks for compression.
      "accept-encoding": "identity",
      "user-agent": "cemp-audit-gate/1.0",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`audit-deps: advisory endpoint returned HTTP ${response.status}`);
  }
  return await response.json();
}

const resolved = [...prodClosure().entries()];
const versionCount = resolved.reduce((sum, [, vs]) => sum + vs.size, 0);

const findings = [];
for (let i = 0; i < resolved.length; i += BATCH) {
  const advisories = await fetchAdvisories(resolved.slice(i, i + BATCH));
  for (const [name, entries] of Object.entries(advisories)) {
    for (const advisory of entries) {
      if (FAIL_SEVERITIES.has(advisory.severity)) {
        findings.push({
          name,
          severity: advisory.severity,
          title: advisory.title,
          url: advisory.url,
        });
      }
    }
  }
}

console.log(
  `audit-deps: scanned ${resolved.length} prod packages (${versionCount} resolved versions)`,
);
if (findings.length > 0) {
  for (const f of findings) {
    console.error(`  ${f.severity.toUpperCase()}  ${f.name}: ${f.title} (${f.url})`);
  }
  console.error(`audit-deps: ${findings.length} high/critical finding(s) — gate FAILED`);
  process.exit(1);
}
console.log("audit-deps: no high/critical advisories — gate PASSED");
