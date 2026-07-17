import { describe, expect, it } from "vitest";
import {
  BIP39_SEED_BYTES,
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
  validateMnemonic,
} from "./bip39.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Official BIP39 English test vector (TREZOR python-mnemonic vectors.json).
const VECTOR_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon about";
const VECTOR_PASSPHRASE = "TREZOR";
const VECTOR_SEED_HEX =
  "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531" +
  "f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04";

describe("mnemonicToSeed", () => {
  it("matches the official BIP39 English test vector (full seed hex)", () => {
    const seed = mnemonicToSeed(VECTOR_MNEMONIC, VECTOR_PASSPHRASE);
    expect(seed).toHaveLength(BIP39_SEED_BYTES);
    expect(bytesToHex(seed)).toBe(VECTOR_SEED_HEX);
  });

  it("produces a different seed without the passphrase", () => {
    const seed = mnemonicToSeed(VECTOR_MNEMONIC);
    expect(seed).toHaveLength(BIP39_SEED_BYTES);
    expect(bytesToHex(seed)).not.toBe(VECTOR_SEED_HEX);
  });
});

describe("validateMnemonic", () => {
  it("accepts the vector mnemonic", () => {
    expect(validateMnemonic(VECTOR_MNEMONIC)).toBe(true);
  });

  it("rejects a checksum-corrupted mnemonic", () => {
    // Every word is in the wordlist; only the checksum is wrong.
    const corrupted = VECTOR_MNEMONIC.replace(/about$/, "abandon");
    expect(validateMnemonic(corrupted)).toBe(false);
  });

  it("rejects an 11-word phrase", () => {
    const elevenWords = VECTOR_MNEMONIC.split(" ").slice(0, 11).join(" ");
    expect(validateMnemonic(elevenWords)).toBe(false);
  });

  it("rejects a word outside the English wordlist", () => {
    expect(validateMnemonic(VECTOR_MNEMONIC.replace(/about$/, "xyzzy"))).toBe(false);
  });
});

describe("generateMnemonic", () => {
  it("generates valid 12-word mnemonics, unique across 5 runs", () => {
    const phrases = Array.from({ length: 5 }, () => generateMnemonic(12));
    for (const phrase of phrases) {
      expect(phrase.split(" ")).toHaveLength(12);
      expect(validateMnemonic(phrase)).toBe(true);
    }
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it("generates valid 24-word mnemonics, unique across 5 runs", () => {
    const phrases = Array.from({ length: 5 }, () => generateMnemonic(24));
    for (const phrase of phrases) {
      expect(phrase.split(" ")).toHaveLength(24);
      expect(validateMnemonic(phrase)).toBe(true);
    }
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});

describe("mnemonicToEntropy ↔ entropyToMnemonic", () => {
  // The official vector's entropy is 128 zero bits (TREZOR vectors.json).
  it("round-trips the official 12-word vector through 16 zero bytes", () => {
    const entropy = mnemonicToEntropy(VECTOR_MNEMONIC);
    expect(bytesToHex(entropy)).toBe("00000000000000000000000000000000");
    expect(entropyToMnemonic(entropy)).toBe(VECTOR_MNEMONIC);
  });

  it("round-trips generated 12-word mnemonics (16-byte entropy)", () => {
    for (let i = 0; i < 5; i++) {
      const phrase = generateMnemonic(12);
      const entropy = mnemonicToEntropy(phrase);
      expect(entropy).toHaveLength(16);
      expect(entropyToMnemonic(entropy)).toBe(phrase);
    }
  });

  it("round-trips generated 24-word mnemonics (32-byte entropy)", () => {
    for (let i = 0; i < 5; i++) {
      const phrase = generateMnemonic(24);
      const entropy = mnemonicToEntropy(phrase);
      expect(entropy).toHaveLength(32);
      expect(entropyToMnemonic(entropy)).toBe(phrase);
    }
  });

  it("rejects a checksum-corrupted mnemonic", () => {
    const corrupted = VECTOR_MNEMONIC.replace(/about$/, "abandon");
    expect(() => mnemonicToEntropy(corrupted)).toThrow();
  });

  it("rejects entropy of a non-standard length", () => {
    // BIP39 allows 128–256 bits in 32-bit steps only; 17 bytes is invalid.
    expect(() => entropyToMnemonic(new Uint8Array(17))).toThrow();
  });
});
