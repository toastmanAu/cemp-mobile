import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codec } from "@cemp/core";
import { deriveRotatedIdentityKeys, mnemonicToSeed } from "@cemp/crypto";

import { loadCtx } from "./chain.js";
import {
  ALICE_MNEMONIC,
  currentRotationIndex,
  deriveIdentity,
  deriveProfileKeys,
} from "./identities.js";
import type { RotationRecord } from "./state.js";

const hex = (b: Uint8Array): string => codec.bytesToHex(b);

const ROTATION: RotationRecord = {
  oldProfileId: "aa".repeat(32),
  oldMlDsaPublicKey: "bb",
  oldKemPublicKey: "cc",
  newProfileId: "dd".repeat(32),
  txHash: `0x${"ee".repeat(32)}`,
};

function aliceRotation1(): { mlDsa: string; mlKem: string } {
  const seed = mnemonicToSeed(ALICE_MNEMONIC);
  const keys = deriveRotatedIdentityKeys(seed, 1);
  seed.fill(0);
  return { mlDsa: hex(keys.mlDsa.publicKey), mlKem: hex(keys.mlKem.publicKey) };
}

describe("current profile keys follow the recorded rotation", () => {
  it("alice is at rotation 1 once a rotation is recorded, 0 before", () => {
    expect(currentRotationIndex("alice", null)).toBe(0);
    expect(currentRotationIndex("alice", ROTATION)).toBe(1);
  });

  it("bob never rotates in this harness (the record is alice's)", () => {
    expect(currentRotationIndex("bob", ROTATION)).toBe(0);
  });

  it("deriveProfileKeys(0) is the base identity; (1) is the rotation-1 bundle", () => {
    expect(hex(deriveProfileKeys("alice", 0).mlDsa.publicKey)).toBe(
      hex(deriveIdentity("alice").mlDsa.publicKey),
    );
    const r1 = deriveProfileKeys("alice", 1);
    expect(hex(r1.mlDsa.publicKey)).toBe(aliceRotation1().mlDsa);
    expect(hex(r1.mlKem.publicKey)).toBe(aliceRotation1().mlKem);
    expect(hex(r1.mlDsa.publicKey)).not.toBe(hex(deriveIdentity("alice").mlDsa.publicKey));
  });
});

describe("loadCtx identities after a rotation (bug: send signed with the retired key)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("alice.bundle flips to the rotation-1 keys the moment rotation is recorded; funding does not", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cemp-ref-"));
    dirs.push(dir);
    const ctx = await loadCtx(dir);
    const alice = ctx.identities.alice;
    const base = deriveIdentity("alice");
    const lockBefore = alice.lock.hash();

    expect(hex(alice.bundle.mlDsa.publicKey)).toBe(hex(base.mlDsa.publicKey));

    // Exactly what the rotate step does on commit (rotate.ts).
    ctx.shared.rotation = ROTATION;

    // Envelope signing + decryption use the CURRENT profile keys...
    expect(hex(alice.bundle.mlDsa.publicKey)).toBe(aliceRotation1().mlDsa);
    expect(hex(alice.bundle.mlKem.publicKey)).toBe(aliceRotation1().mlKem);
    // ...while the funding wallet stays on the rotation-0 lock, where the
    // spendable CKB actually lives.
    expect(hex(alice.walletBundle.mlDsa.publicKey)).toBe(hex(base.mlDsa.publicKey));
    expect(alice.lock.hash()).toBe(lockBefore);
    // Bob is untouched.
    expect(hex(ctx.identities.bob.bundle.mlDsa.publicKey)).toBe(
      hex(deriveIdentity("bob").mlDsa.publicKey),
    );
  });

  it("a context loaded from state that already records the rotation starts on rotation-1 keys", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cemp-ref-"));
    dirs.push(dir);
    const first = await loadCtx(dir);
    first.shared.rotation = ROTATION;
    first.save();

    const reloaded = await loadCtx(dir);
    expect(hex(reloaded.identities.alice.bundle.mlDsa.publicKey)).toBe(aliceRotation1().mlDsa);
  });
});
