import { describe, expect, it } from "vitest";
import { deriveMessageKey, deriveSubSeed, hkdfSha256 } from "./hkdf.js";
import { KDF_DOMAIN } from "./domains.js";

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

describe("hkdfSha256", () => {
  // RFC 5869, Test Case 1 (SHA-256).
  it("matches RFC 5869 test case 1", () => {
    const ikm = hexToBytes("0b".repeat(22));
    const salt = hexToBytes("000102030405060708090a0b0c");
    const info = hexToBytes("f0f1f2f3f4f5f6f7f8f9");
    const okm = hkdfSha256(ikm, salt, info, 42);
    expect(bytesToHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a" +
        "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
        "34007208d5b887185865",
    );
  });

  it("accepts string info (UTF-8 encoded)", () => {
    const ikm = hexToBytes("0b".repeat(22));
    const salt = hexToBytes("000102030405060708090a0b0c");
    const viaString = hkdfSha256(ikm, salt, "f0f1f2f3f4f5f6f7f8f9", 42);
    const viaBytes = hkdfSha256(ikm, salt, hexToBytes("f0f1f2f3f4f5f6f7f8f9"), 42);
    // String is UTF-8 text, hex bytes are raw — different info must differ.
    expect(bytesToHex(viaString)).not.toBe(bytesToHex(viaBytes));
  });
});

describe("deriveSubSeed", () => {
  const fakeSeed = hexToBytes("ab".repeat(64));

  it("is deterministic", () => {
    expect(bytesToHex(deriveSubSeed(fakeSeed, KDF_DOMAIN.IdentityMlDsa))).toBe(
      bytesToHex(deriveSubSeed(fakeSeed, KDF_DOMAIN.IdentityMlDsa)),
    );
  });

  it("produces independent sub-seeds per domain (spec §5.2)", () => {
    const dsa = deriveSubSeed(fakeSeed, KDF_DOMAIN.IdentityMlDsa);
    const kem = deriveSubSeed(fakeSeed, KDF_DOMAIN.MessagingMlKem);
    const db = deriveSubSeed(fakeSeed, KDF_DOMAIN.LocalDatabase);
    expect(bytesToHex(dsa)).not.toBe(bytesToHex(kem));
    expect(bytesToHex(dsa)).not.toBe(bytesToHex(db));
    expect(bytesToHex(kem)).not.toBe(bytesToHex(db));
    expect(dsa).toHaveLength(32);
  });
});

describe("deriveMessageKey", () => {
  const secret = hexToBytes("cd".repeat(32));
  const nonce = hexToBytes("ef".repeat(12));
  const alice = hexToBytes("11".repeat(32));
  const bob = hexToBytes("22".repeat(32));

  it("binds sender and recipient into the key", () => {
    const forBob = deriveMessageKey(secret, nonce, alice, bob);
    const forCarol = deriveMessageKey(secret, nonce, alice, hexToBytes("33".repeat(32)));
    expect(bytesToHex(forBob)).not.toBe(bytesToHex(forCarol));
  });

  it("binds the envelope nonce as salt", () => {
    const a = deriveMessageKey(secret, nonce, alice, bob);
    const b = deriveMessageKey(secret, hexToBytes("ee".repeat(12)), alice, bob);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});
