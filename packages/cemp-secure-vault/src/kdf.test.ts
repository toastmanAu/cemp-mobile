import { describe, expect, it } from "vitest";
import { VaultError } from "./errors.js";
import {
  KDF_SALT_BYTES,
  KEK_BYTES,
  deriveKek,
  resolveKdfParams,
  validateKdfParams,
  type Argon2idKdfParams,
  type KdfParams,
  type ScryptKdfParams,
} from "./kdf.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const PASSWORD = "cemp-vault-test-password";
// Sequential 16-byte salt (00..0f).
const SALT = Uint8Array.from({ length: 16 }, (_, i) => i);

function expectOutOfRange(params: KdfParams): void {
  try {
    validateKdfParams(params);
    expect.unreachable("validateKdfParams accepted out-of-range parameters");
  } catch (e) {
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).code).toBe("kdf-params-out-of-range");
  }
}

describe("deriveKek known-answer tests", () => {
  // Pinned outputs for tiny parameters, computed with @noble/hashes 2.2.0
  // argon2id (noble validates its implementation against the RFC 9106
  // vectors; the RFC vectors themselves mix in optional secret/associated
  // data that the mobile KDF profile does not use, so these pin the profile
  // actually recorded in vault files).
  it("argon2id m=32 t=2 p=1 matches the pinned output", () => {
    const kek = deriveKek(PASSWORD, { alg: "argon2id", m: 32, t: 2, p: 1, salt: SALT });
    expect(kek).toHaveLength(KEK_BYTES);
    expect(bytesToHex(kek)).toBe(
      "e9461e95231ad67145ae9d19b203fe9d6c471869233d8a07c9dfa2917235ee10",
    );
  });

  it("argon2id m=64 t=3 p=1 matches the pinned output", () => {
    const kek = deriveKek(PASSWORD, { alg: "argon2id", m: 64, t: 3, p: 1, salt: SALT });
    expect(bytesToHex(kek)).toBe(
      "495e09a32a7af5270bfc08477185c77156430d0a9bbea396da3fbccd4b6e9422",
    );
  });

  // RFC 7914 §12 vectors. They are published with dkLen = 64; scrypt's final
  // PBKDF2 block 1 is dkLen-independent, so our 32-byte KEK is the 32-byte
  // prefix of the published 64-byte outputs.
  it("scrypt matches RFC 7914 vector 1 (empty password/salt, N=16, r=1, p=1)", () => {
    const kek = deriveKek("", { alg: "scrypt", logN: 4, r: 1, p: 1, salt: new Uint8Array(0) });
    expect(bytesToHex(kek)).toBe(
      "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442",
    );
  });

  it("scrypt matches RFC 7914 vector 2 ('password'/'NaCl', N=1024, r=8, p=16)", () => {
    // p=16 exceeds the vault file caps — deriveKek does not validate; only
    // parsed files are capped (the vector proves algorithm conformance, and a
    // hostile file could never request these parameters through parse).
    const kek = deriveKek("password", {
      alg: "scrypt",
      logN: 10,
      r: 8,
      p: 16,
      salt: new TextEncoder().encode("NaCl"),
    });
    expect(bytesToHex(kek)).toBe(
      "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162",
    );
  });

  it("derives different KEKs for different salts and passwords", () => {
    const params: Argon2idKdfParams = { alg: "argon2id", m: 8, t: 1, p: 1, salt: SALT };
    const a = deriveKek(PASSWORD, params);
    const b = deriveKek(PASSWORD, { ...params, salt: hexToBytes("10".repeat(16)) });
    const c = deriveKek("other-password", params);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(bytesToHex(a)).not.toBe(bytesToHex(c));
  });
});

describe("resolveKdfParams defaults (recorded in the vault file)", () => {
  const salt = new Uint8Array(KDF_SALT_BYTES);

  it("defaults to argon2id m=64 MiB t=3 p=1 (RFC 9106 first recommendation)", () => {
    expect(resolveKdfParams(undefined, salt)).toEqual({
      alg: "argon2id",
      m: 65_536,
      t: 3,
      p: 1,
      salt,
    });
  });

  it("scrypt selection defaults to logN=17 r=8 p=1 (key-vault-wasm profile)", () => {
    expect(resolveKdfParams({ alg: "scrypt" }, salt)).toEqual({
      alg: "scrypt",
      logN: 17,
      r: 8,
      p: 1,
      salt,
    });
  });

  it("honours partial overrides and keeps the generated salt", () => {
    expect(resolveKdfParams({ alg: "argon2id", m: 8 }, salt)).toEqual({
      alg: "argon2id",
      m: 8,
      t: 3,
      p: 1,
      salt,
    });
    expect(resolveKdfParams({ alg: "scrypt", logN: 10, p: 2 }, salt)).toEqual({
      alg: "scrypt",
      logN: 10,
      r: 8,
      p: 2,
      salt,
    });
  });
});

describe("validateKdfParams (hostile-file DoS caps, rule 4)", () => {
  const argon: Argon2idKdfParams = { alg: "argon2id", m: 65_536, t: 3, p: 1, salt: SALT };
  const scryptParams: ScryptKdfParams = { alg: "scrypt", logN: 17, r: 8, p: 1, salt: SALT };

  it("accepts both default profiles and the cap boundary values", () => {
    expect(() => validateKdfParams(argon)).not.toThrow();
    expect(() => validateKdfParams(scryptParams)).not.toThrow();
    expect(() =>
      validateKdfParams({ alg: "argon2id", m: 1_048_576, t: 16, p: 8, salt: SALT }),
    ).not.toThrow();
    expect(() =>
      validateKdfParams({ alg: "scrypt", logN: 20, r: 8, p: 8, salt: SALT }),
    ).not.toThrow();
  });

  it("rejects argon2id memory above 1 GiB", () => {
    expectOutOfRange({ ...argon, m: 1_048_577 });
  });

  it("rejects argon2id iterations above 16 and lanes above 8", () => {
    expectOutOfRange({ ...argon, t: 17 });
    expectOutOfRange({ ...argon, p: 9 });
  });

  it("rejects argon2id memory below the 8·p floor (RFC 9106)", () => {
    expectOutOfRange({ ...argon, m: 7 });
    expectOutOfRange({ ...argon, m: 16, p: 4 }); // 16 < 8·4
  });

  it("rejects scrypt logN above 20 and r/p above 8", () => {
    expectOutOfRange({ ...scryptParams, logN: 21 });
    expectOutOfRange({ ...scryptParams, r: 9 });
    expectOutOfRange({ ...scryptParams, p: 9 });
    expectOutOfRange({ ...scryptParams, logN: 0 });
  });

  it("rejects non-integer parameters", () => {
    expectOutOfRange({ ...argon, m: 65_536.5 });
    expectOutOfRange({ ...scryptParams, logN: 17.5 });
  });

  it("rejects salts outside 8..64 bytes", () => {
    expectOutOfRange({ ...argon, salt: new Uint8Array(7) });
    expectOutOfRange({ ...argon, salt: new Uint8Array(65) });
    expect(() => validateKdfParams({ ...argon, salt: new Uint8Array(8) })).not.toThrow();
    expect(() => validateKdfParams({ ...argon, salt: new Uint8Array(64) })).not.toThrow();
  });
});
