import { describe, expect, it } from "vitest";
import { mnemonicToSeed } from "./bip39.js";
import {
  deriveIdentityKeys,
  deriveRotatedIdentityKeys,
  wipeIdentityKeyBundle,
} from "./identity.js";

/**
 * Profile key rotation derivation (spec §5.3, protocol §5): rotation 0 is the
 * base identity; N ≥ 1 advances the sub-seeds via HKDF with a u32-LE suffix.
 */
const TREZOR_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon about";

describe("deriveRotatedIdentityKeys", () => {
  const seed = mnemonicToSeed(TREZOR_MNEMONIC);

  it("rotation 0 is byte-for-byte deriveIdentityKeys (backward compat)", () => {
    const base = deriveIdentityKeys(seed);
    const rot0 = deriveRotatedIdentityKeys(seed, 0);
    expect(rot0.mlDsa.publicKey).toEqual(base.mlDsa.publicKey);
    expect(rot0.mlDsa.secretKey).toEqual(base.mlDsa.secretKey);
    expect(rot0.mlKem.publicKey).toEqual(base.mlKem.publicKey);
    expect(rot0.mlKem.secretKey).toEqual(base.mlKem.secretKey);
    expect(rot0.localDatabaseKey).toEqual(base.localDatabaseKey);
    wipeIdentityKeyBundle(base);
    wipeIdentityKeyBundle(rot0);
  });

  it("rotations are deterministic, distinct, and keep the database key stable", () => {
    const base = deriveIdentityKeys(seed);
    const r1a = deriveRotatedIdentityKeys(seed, 1);
    const r1b = deriveRotatedIdentityKeys(seed, 1);
    const r2 = deriveRotatedIdentityKeys(seed, 2);

    expect(r1a.mlDsa.publicKey).toEqual(r1b.mlDsa.publicKey);
    expect(r1a.mlKem.publicKey).toEqual(r1b.mlKem.publicKey);
    // Every rotation changes BOTH messaging keypairs.
    expect(r1a.mlDsa.publicKey).not.toEqual(base.mlDsa.publicKey);
    expect(r1a.mlKem.publicKey).not.toEqual(base.mlKem.publicKey);
    expect(r2.mlDsa.publicKey).not.toEqual(r1a.mlDsa.publicKey);
    expect(r2.mlKem.publicKey).not.toEqual(r1a.mlKem.publicKey);
    // The local database key is local material — never rotated.
    expect(r1a.localDatabaseKey).toEqual(base.localDatabaseKey);
    expect(r2.localDatabaseKey).toEqual(base.localDatabaseKey);

    for (const bundle of [base, r1a, r1b, r2]) {
      wipeIdentityKeyBundle(bundle);
    }
  });

  it("golden: rotation 1 of the TREZOR zero-entropy vector is stable", () => {
    // Guards the rotation domain strings + u32-LE suffix against silent drift
    // (rule 13 — changing either changes every rotated key).
    const r1 = deriveRotatedIdentityKeys(seed, 1);
    const hex = (b: Uint8Array): string =>
      Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(r1.mlDsa.publicKey).slice(0, 64)).toBe(
      "07d71310bf07a158addada1e05575044060995307ad659292406e2bf5ad8f54d",
    );
    expect(hex(r1.mlKem.publicKey).slice(0, 64)).toBe(
      "afe8410f46a8697b2e8215b6751ac297911fd7076e7bf4c8cd865f6ad32f3532",
    );
    wipeIdentityKeyBundle(r1);
  });

  it("rejects non-uint32 rotations and bad seed lengths", () => {
    expect(() => deriveRotatedIdentityKeys(seed, -1)).toThrow();
    expect(() => deriveRotatedIdentityKeys(seed, 1.5)).toThrow();
    expect(() => deriveRotatedIdentityKeys(seed, 0x1_00_00_00_00)).toThrow();
    expect(() => deriveRotatedIdentityKeys(new Uint8Array(32), 1)).toThrow();
  });
});
