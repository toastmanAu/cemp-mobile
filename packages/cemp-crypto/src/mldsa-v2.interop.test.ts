import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import {
  buildFinalMessage,
  cighashV2Digest,
  mldsaV2KeygenFromSeed,
  mldsaV2Sign,
} from "./mldsa-v2.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Repo root is three levels up from packages/cemp-crypto/src/.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const harnessManifest = "tools/signing-harness/Cargo.toml";
const harnessAvailable =
  existsSync(new URL(`../../../${harnessManifest}`, import.meta.url)) &&
  spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

const CARGO_TIMEOUT_MS = 300_000; // first run may compile the harness

function harnessVerify(pubkeyHex: string, signatureHex: string, streamHex: string) {
  return spawnSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      harnessManifest,
      "--",
      "verify",
      "--pubkey",
      pubkeyHex,
      "--signature",
      signatureHex,
      "--stream",
      streamHex,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: CARGO_TIMEOUT_MS },
  );
}

describe("mldsa-v2 interop: noble signature verified by the Rust harness", () => {
  it.skipIf(!harnessAvailable)(
    "hedged noble signature verifies OK under the fips204 pipeline",
    { timeout: CARGO_TIMEOUT_MS },
    () => {
      const sc = vectors.sign[0]!;
      const { publicKey, secretKey } = mldsaV2KeygenFromSeed(hexToBytes(sc.seed));
      expect(bytesToHex(publicKey)).toBe(sc.pubkey);

      const stream = hexToBytes(sc.stream);
      const digest = cighashV2Digest(stream);
      // M' is informational (the FIPS-204 implementation frames it
      // internally); assert the TS framing helper still matches the vectors.
      expect(bytesToHex(buildFinalMessage(digest))).toBe(sc.finalMessage);

      // Hedged (randomised) signature — different bytes than the vector's
      // deterministic one, but the on-chain-equivalent Rust verifier must
      // still accept it.
      const hedged = mldsaV2Sign(secretKey, digest);
      const res = harnessVerify(sc.pubkey, bytesToHex(hedged), sc.stream);
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe("OK");
    },
  );

  it.skipIf(!harnessAvailable)(
    "negative control: corrupted stream makes the harness print FAIL (exit 1)",
    { timeout: CARGO_TIMEOUT_MS },
    () => {
      const sc = vectors.sign[0]!;
      const { secretKey } = mldsaV2KeygenFromSeed(hexToBytes(sc.seed));

      const stream = hexToBytes(sc.stream);
      const hedged = mldsaV2Sign(secretKey, cighashV2Digest(stream));

      // Flip one byte of the stream AFTER signing — the harness recomputes
      // digest → final message from the corrupted stream, so verification
      // must fail.
      const corrupted = new Uint8Array(stream);
      corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0x01;

      const res = harnessVerify(sc.pubkey, bytesToHex(hedged), bytesToHex(corrupted));
      expect(res.status).toBe(1);
      expect(res.stdout.trim()).toBe("FAIL");
    },
  );
});
