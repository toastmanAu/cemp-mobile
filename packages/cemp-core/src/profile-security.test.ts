import { describe, expect, it } from "vitest";
import {
  decodeContactBundle,
  encodeContactBundle,
  type ContactBundleV1,
} from "./contact-bundle.js";
import {
  formatFingerprint,
  fingerprintBytes,
  fingerprintsEqual,
  parseFingerprint,
} from "./fingerprint.js";
import {
  evaluateContactProfile,
  validateRotationChain,
  type ProfileTrustView,
} from "./profile-trust.js";

/**
 * Phase 5 offline trust battery: fingerprints, contact bundles, rotation
 * chains and trust verdicts. The golden fingerprint/bundle strings here pin
 * the wire formats (rule 13).
 */
function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

const PROFILE_ID = fill(0x11, 32);
const DSA_PK = fill(0x22, 1952);
const KEM_PK = fill(0x33, 1184);

describe("fingerprint", () => {
  it("is deterministic and formatted as 8 dash-separated groups", () => {
    const fp = formatFingerprint({
      profileId: PROFILE_ID,
      mlDsaPublicKey: DSA_PK,
      mlKemPublicKey: KEM_PK,
    });
    expect(fp).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);
    // Golden: pins the personalisation + input layout (rule 13).
    expect(fp).toBe("AC2A-3EB2-3695-BFE8-6997-B339-E98F-5ED2");
    expect(
      fingerprintBytes({ profileId: PROFILE_ID, mlDsaPublicKey: DSA_PK, mlKemPublicKey: KEM_PK }),
    ).toHaveLength(16);
  });

  it("parse accepts dashed/undashed/lowercase and rejects garbage", () => {
    const fp = formatFingerprint({
      profileId: PROFILE_ID,
      mlDsaPublicKey: DSA_PK,
      mlKemPublicKey: KEM_PK,
    });
    expect(parseFingerprint(fp)).toBe(fp);
    expect(parseFingerprint(fp.replace(/-/g, ""))).toBe(fp);
    expect(parseFingerprint(fp.toLowerCase())).toBe(fp);
    expect(() => parseFingerprint("ABCD-1234")).toThrow();
    expect(() => parseFingerprint("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ")).toThrow();
    expect(fingerprintsEqual(fp, fp.toLowerCase())).toBe(true);
    expect(fingerprintsEqual(fp, "0000-0000-0000-0000-0000-0000-0000-0000")).toBe(false);
  });
});

describe("contact bundle v1", () => {
  const bundle: ContactBundleV1 = {
    profileTypeId: "0x" + "ab".repeat(32),
    lockScriptHash: "0x" + "cd".repeat(32),
    address: "ckt1qzexampleaddress000000000000000000000000000000000000",
    fingerprint: formatFingerprint({
      profileId: PROFILE_ID,
      mlDsaPublicKey: DSA_PK,
      mlKemPublicKey: KEM_PK,
    }),
    network: "ckb_testnet",
  };

  it("encode → decode round-trips with canonical key order", () => {
    const text = encodeContactBundle(bundle);
    expect(text.startsWith('{"protocol":"cemp-contact","version":1,')).toBe(true);
    expect(decodeContactBundle(text)).toEqual(bundle);
  });

  it("rejects hostile bundles (rule 4)", () => {
    const as = (patch: Record<string, unknown>): string =>
      JSON.stringify({ protocol: "cemp-contact", version: 1, ...bundle, ...patch });
    expect(() => decodeContactBundle("not json")).toThrow();
    expect(() => decodeContactBundle(as({ protocol: "other" }))).toThrow();
    expect(() => decodeContactBundle(as({ version: 2 }))).toThrow();
    expect(() => decodeContactBundle(as({ network: "ckb" }))).toThrow(); // mainnet rejected (rule 11)
    expect(() => decodeContactBundle(as({ profileTypeId: "0xAB" + "ab".repeat(31) }))).toThrow(); // uppercase
    expect(() => decodeContactBundle(as({ profileTypeId: "0x" + "ab".repeat(31) }))).toThrow(); // short
    expect(() => decodeContactBundle(as({ address: "ckb1qmainnet" }))).toThrow();
    expect(() => decodeContactBundle(as({ fingerprint: "nope" }))).toThrow();
  });
});

describe("profile trust", () => {
  const base: ProfileTrustView = {
    profileId: PROFILE_ID,
    mlDsaPublicKey: DSA_PK,
    mlKemPublicKey: KEM_PK,
    rotationSequence: 0,
    previousProfileId: null,
    revoked: false,
  };
  const rotated: ProfileTrustView = {
    profileId: fill(0x44, 32),
    mlDsaPublicKey: fill(0x55, 1952),
    mlKemPublicKey: fill(0x66, 1184),
    rotationSequence: 1,
    previousProfileId: PROFILE_ID,
    revoked: false,
  };

  it("validates well-formed chains and rejects broken ones", () => {
    expect(validateRotationChain([base]).valid).toBe(true);
    expect(validateRotationChain([base, rotated]).valid).toBe(true);
    expect(validateRotationChain([]).valid).toBe(false);
    // Skipped sequence.
    expect(validateRotationChain([base, { ...rotated, rotationSequence: 2 }]).valid).toBe(false);
    // Link names the wrong predecessor.
    expect(
      validateRotationChain([base, { ...rotated, previousProfileId: fill(0x99, 32) }]).valid,
    ).toBe(false);
    // Root names a previous profile.
    expect(validateRotationChain([{ ...base, previousProfileId: fill(0x99, 32) }]).valid).toBe(
      false,
    );
  });

  it("verdicts: first-use, trusted, rotation-verified, key-changed-blocking", () => {
    const saved = { profileId: PROFILE_ID, mlDsaPublicKey: DSA_PK, mlKemPublicKey: KEM_PK };
    expect(evaluateContactProfile(null, base, [base]).verdict).toBe("first-use");
    expect(evaluateContactProfile(saved, base, [base]).verdict).toBe("trusted");
    expect(evaluateContactProfile(saved, rotated, [base, rotated]).verdict).toBe(
      "rotation-verified",
    );
    // Keys changed with no chain → blocking warning (Phase 5 exit criterion).
    const blocked = evaluateContactProfile(saved, rotated, [rotated]);
    expect(blocked.verdict).toBe("key-changed-blocking");
    expect(blocked.warning).toBeDefined();
    // A chain that does not start at the SAVED profile id does not clear it.
    const forgedRoot: ProfileTrustView = { ...base, profileId: fill(0x77, 32) };
    expect(
      evaluateContactProfile(saved, rotated, [
        forgedRoot,
        { ...rotated, previousProfileId: fill(0x77, 32) },
      ]).verdict,
    ).toBe("key-changed-blocking");
  });
});
