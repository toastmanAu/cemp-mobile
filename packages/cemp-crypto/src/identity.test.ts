import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { describe, expect, it } from "vitest";
import { KDF_DOMAIN } from "./domains.js";
import { CempCryptoError } from "./errors.js";
import { deriveSubSeed, hkdfSha256 } from "./hkdf.js";
import {
  deriveIdentityKeys,
  deriveLocalDatabaseKey,
  LOCAL_DATABASE_KEY_BYTES,
  ML_KEM_768_SIZES,
  wipeIdentityKeyBundle,
} from "./identity.js";
import { MLDSA_V2_SIZES, mldsaV2KeygenFromSeed } from "./mldsa-v2.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const seedA = new Uint8Array(64).fill(0xab);
const seedB = new Uint8Array(64).fill(0xcd);

describe("deriveIdentityKeys", () => {
  it("is deterministic: the same seed yields the same bundle", () => {
    const first = deriveIdentityKeys(seedA);
    const second = deriveIdentityKeys(seedA);
    expect(bytesToHex(second.mlDsa.publicKey)).toBe(bytesToHex(first.mlDsa.publicKey));
    expect(bytesToHex(second.mlDsa.secretKey)).toBe(bytesToHex(first.mlDsa.secretKey));
    expect(bytesToHex(second.mlKem.publicKey)).toBe(bytesToHex(first.mlKem.publicKey));
    expect(bytesToHex(second.mlKem.secretKey)).toBe(bytesToHex(first.mlKem.secretKey));
    expect(bytesToHex(second.localDatabaseKey)).toBe(bytesToHex(first.localDatabaseKey));
  });

  it("derives different keys for different seeds", () => {
    const a = deriveIdentityKeys(seedA);
    const b = deriveIdentityKeys(seedB);
    expect(bytesToHex(b.mlDsa.publicKey)).not.toBe(bytesToHex(a.mlDsa.publicKey));
    expect(bytesToHex(b.mlKem.publicKey)).not.toBe(bytesToHex(a.mlKem.publicKey));
    expect(bytesToHex(b.localDatabaseKey)).not.toBe(bytesToHex(a.localDatabaseKey));
  });

  it("matches direct ML-DSA keygen from the identity sub-seed (spec §4)", () => {
    const bundle = deriveIdentityKeys(seedA);
    const expected = mldsaV2KeygenFromSeed(deriveSubSeed(seedA, KDF_DOMAIN.IdentityMlDsa));
    expect(bytesToHex(bundle.mlDsa.publicKey)).toBe(bytesToHex(expected.publicKey));
    expect(bytesToHex(bundle.mlDsa.secretKey)).toBe(bytesToHex(expected.secretKey));
  });

  it("expands the messaging sub-seed to 64 bytes before ML-KEM keygen (spec §4)", () => {
    const bundle = deriveIdentityKeys(seedA);
    const messagingSubSeed = deriveSubSeed(seedA, KDF_DOMAIN.MessagingMlKem);
    const keygenSeed = hkdfSha256(
      messagingSubSeed,
      undefined,
      KDF_DOMAIN.MlKemKeygen,
      ML_KEM_768_SIZES.keygenSeed,
    );
    const expected = ml_kem768.keygen(keygenSeed);
    expect(bytesToHex(bundle.mlKem.publicKey)).toBe(bytesToHex(expected.publicKey));
    expect(bytesToHex(bundle.mlKem.secretKey)).toBe(bytesToHex(expected.secretKey));
  });

  it("derives independent ML-DSA and ML-KEM keypairs (spec §5.2)", () => {
    const bundle = deriveIdentityKeys(seedA);
    expect(bytesToHex(bundle.mlDsa.publicKey)).not.toBe(bytesToHex(bundle.mlKem.publicKey));
    expect(bytesToHex(bundle.mlDsa.secretKey)).not.toBe(bytesToHex(bundle.mlKem.secretKey));
  });

  it("has the FIPS 203/204 sizes", () => {
    const bundle = deriveIdentityKeys(seedA);
    expect(bundle.mlDsa.publicKey).toHaveLength(MLDSA_V2_SIZES.pk);
    expect(bundle.mlDsa.secretKey).toHaveLength(MLDSA_V2_SIZES.sk);
    expect(bundle.mlKem.publicKey).toHaveLength(ML_KEM_768_SIZES.publicKey);
    expect(bundle.mlKem.secretKey).toHaveLength(ML_KEM_768_SIZES.secretKey);
    expect(bundle.localDatabaseKey).toHaveLength(LOCAL_DATABASE_KEY_BYTES);
  });

  it("rejects a non-64-byte seed", () => {
    expect(() => deriveIdentityKeys(new Uint8Array(32))).toThrow(CempCryptoError);
  });
});

describe("deriveLocalDatabaseKey", () => {
  it("is 32 bytes, deterministic, and matches the bundle's key", () => {
    const standalone = deriveLocalDatabaseKey(seedA);
    expect(standalone).toHaveLength(32);
    expect(bytesToHex(deriveLocalDatabaseKey(seedA))).toBe(bytesToHex(standalone));
    expect(bytesToHex(deriveIdentityKeys(seedA).localDatabaseKey)).toBe(bytesToHex(standalone));
  });

  it("is domain-separated from the other sub-seeds", () => {
    const key = deriveLocalDatabaseKey(seedA);
    expect(bytesToHex(key)).not.toBe(bytesToHex(deriveSubSeed(seedA, KDF_DOMAIN.MessagingMlKem)));
    expect(bytesToHex(key)).not.toBe(bytesToHex(deriveSubSeed(seedA, KDF_DOMAIN.IdentityMlDsa)));
  });
});

describe("wipeIdentityKeyBundle", () => {
  it("zeroes secret material and keeps public keys", () => {
    const bundle = deriveIdentityKeys(seedA);
    wipeIdentityKeyBundle(bundle);
    expect(bundle.mlDsa.secretKey.every((b) => b === 0)).toBe(true);
    expect(bundle.mlKem.secretKey.every((b) => b === 0)).toBe(true);
    expect(bundle.localDatabaseKey.every((b) => b === 0)).toBe(true);
    expect(bundle.mlDsa.publicKey.some((b) => b !== 0)).toBe(true);
    expect(bundle.mlKem.publicKey.some((b) => b !== 0)).toBe(true);
  });
});
