import { aes256GcmDecrypt, aes256GcmEncrypt, randomBytes } from "@cemp/crypto";
import { describe, expect, it } from "vitest";
import { VaultError } from "./errors.js";
import {
  VAULT_FORMAT_VERSION,
  VEK_WRAP_BYTES,
  bytesToHex,
  decodeSecretPayload,
  encodeSecretPayload,
  parseVaultFile,
  payloadAad,
  secretPayloadBytes,
  serializeVaultFile,
  type VaultFileV1,
} from "./format.js";
import type { Argon2idKdfParams, ScryptKdfParams } from "./kdf.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const ARGON_KDF: Argon2idKdfParams = {
  alg: "argon2id",
  m: 8,
  t: 1,
  p: 1,
  salt: Uint8Array.from({ length: 16 }, (_, i) => i),
};

/** A structurally valid v1 fixture (contents are not a real encryption). */
function fixtureFile(overrides: Partial<VaultFileV1> = {}): VaultFileV1 {
  return {
    version: VAULT_FORMAT_VERSION,
    kdf: ARGON_KDF,
    passwordSlot: {
      nonce: new Uint8Array(12).fill(0x11),
      wrappedVek: new Uint8Array(VEK_WRAP_BYTES).fill(0x22),
    },
    biometricSlot: null,
    payload: {
      nonce: new Uint8Array(12).fill(0x33),
      ct: new Uint8Array(secretPayloadBytes(12) + 16).fill(0x44),
    },
    meta: {
      createdAt: 1_750_000_000_000,
      wordCount: 12,
      hasPassphrase: false,
      autoLockSeconds: 300,
    },
    ...overrides,
  };
}

function parseFixture(overrides: Partial<VaultFileV1> = {}): VaultFileV1 {
  return parseVaultFile(serializeVaultFile(fixtureFile(overrides)));
}

/** Serialize `file`, apply a textual mutation to the JSON, return the bytes. */
function mutatedWire(
  file: VaultFileV1,
  mutate: (wire: Record<string, unknown>) => void,
): Uint8Array {
  const wire = JSON.parse(textDecoder.decode(serializeVaultFile(file))) as Record<string, unknown>;
  mutate(wire);
  return textEncoder.encode(JSON.stringify(wire));
}

function expectCorrupt(bytes: Uint8Array): void {
  try {
    parseVaultFile(bytes);
    expect.unreachable("parseVaultFile accepted a hostile document");
  } catch (e) {
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).code).toBe("corrupt-vault");
  }
}

describe("secret payload codec", () => {
  it("round-trips 16-byte and 32-byte entropy payloads", () => {
    for (const entropyLength of [16, 32]) {
      const entropy = randomBytes(entropyLength);
      const seed = randomBytes(64);
      for (const hasPassphrase of [false, true]) {
        const decoded = decodeSecretPayload(encodeSecretPayload({ entropy, seed, hasPassphrase }));
        expect(bytesToHex(decoded.entropy)).toBe(bytesToHex(entropy));
        expect(bytesToHex(decoded.seed)).toBe(bytesToHex(seed));
        expect(decoded.hasPassphrase).toBe(hasPassphrase);
      }
    }
  });

  it("has the deterministic layout entropyLen ‖ entropy ‖ seed ‖ flag", () => {
    const entropy = new Uint8Array(16).fill(0xaa);
    const seed = new Uint8Array(64).fill(0xbb);
    const encoded = encodeSecretPayload({ entropy, seed, hasPassphrase: true });
    expect(encoded).toHaveLength(secretPayloadBytes(12));
    expect(encoded[0]).toBe(16);
    expect(encoded[encoded.length - 1]).toBe(1);
    expect(encoded.slice(1, 17).every((b) => b === 0xaa)).toBe(true);
    expect(encoded.slice(17, 81).every((b) => b === 0xbb)).toBe(true);
  });

  it("rejects invalid entropy lengths, total lengths and flag bytes", () => {
    expect(() =>
      encodeSecretPayload({
        entropy: new Uint8Array(17),
        seed: new Uint8Array(64),
        hasPassphrase: false,
      }),
    ).toThrow(VaultError);
    expect(() =>
      encodeSecretPayload({
        entropy: new Uint8Array(16),
        seed: new Uint8Array(63),
        hasPassphrase: false,
      }),
    ).toThrow(VaultError);

    expectCorruptPayload(new Uint8Array([15, ...new Uint8Array(80)])); // entropyLen 15
    expectCorruptPayload(new Uint8Array([16, ...new Uint8Array(80)])); // total too short
    expectCorruptPayload(new Uint8Array([16, ...new Uint8Array(80), 2])); // flag 2
  });

  function expectCorruptPayload(bytes: Uint8Array): void {
    expect(() => decodeSecretPayload(bytes)).toThrow(VaultError);
  }
});

describe("vault file serialize/parse", () => {
  it("round-trips the argon2id fixture byte-for-byte", () => {
    const file = fixtureFile();
    const parsed = parseFixture();
    expect(parsed).toEqual(file);
    // Serialization is canonical: parsing and re-serializing is a fixed point.
    expect(bytesToHex(serializeVaultFile(parsed))).toBe(bytesToHex(serializeVaultFile(file)));
  });

  it("round-trips a scrypt vault with a biometric slot (with and without nonce)", () => {
    const scryptKdf: ScryptKdfParams = {
      alg: "scrypt",
      logN: 17,
      r: 8,
      p: 1,
      salt: new Uint8Array(16).fill(0x55),
    };
    const withNonce = parseFixture({
      kdf: scryptKdf,
      biometricSlot: {
        nonce: new Uint8Array(12).fill(0x66),
        wrappedVek: new Uint8Array(49).fill(0x77),
      },
    });
    expect(withNonce.kdf).toEqual(scryptKdf);
    expect(withNonce.biometricSlot).toEqual({
      nonce: new Uint8Array(12).fill(0x66),
      wrappedVek: new Uint8Array(49).fill(0x77),
    });

    const withoutNonce = parseFixture({
      kdf: scryptKdf,
      biometricSlot: { wrappedVek: new Uint8Array(49).fill(0x77) },
    });
    expect(withoutNonce.biometricSlot).toEqual({ wrappedVek: new Uint8Array(49).fill(0x77) });
  });

  it("rejects a document that is not JSON / not an object", () => {
    expectCorrupt(textEncoder.encode("not json {"));
    expectCorrupt(textEncoder.encode("[1,2,3]"));
    expectCorrupt(textEncoder.encode("42"));
  });

  it("rejects an unknown version", () => {
    expectCorrupt(
      mutatedWire(fixtureFile(), (wire) => {
        wire.version = 2;
      }),
    );
    expectCorrupt(
      mutatedWire(fixtureFile(), (wire) => {
        delete wire.version;
      }),
    );
  });

  it("rejects an unknown KDF algorithm", () => {
    expectCorrupt(
      mutatedWire(fixtureFile(), (wire) => {
        (wire.kdf as Record<string, unknown>).alg = "pbkdf2";
      }),
    );
  });

  it("rejects malformed hex fields (uppercase, odd length, non-hex)", () => {
    const file = fixtureFile();
    expectCorrupt(
      mutatedWire(file, (wire) => {
        (wire.kdf as Record<string, unknown>).salt = "AABBCCDDEEFF00112233445566778899";
      }),
    );
    expectCorrupt(
      mutatedWire(file, (wire) => {
        (wire.kdf as Record<string, unknown>).salt = "abc";
      }),
    );
    expectCorrupt(
      mutatedWire(file, (wire) => {
        (wire.kdf as Record<string, unknown>).salt = "zz".repeat(16);
      }),
    );
  });

  it("rejects missing required fields", () => {
    for (const field of ["kdf", "passwordSlot", "biometricSlot", "payload", "meta"] as const) {
      expectCorrupt(
        mutatedWire(fixtureFile(), (wire) => {
          delete wire[field];
        }),
      );
    }
  });

  it("rejects wrong nonce / wrappedVek lengths", () => {
    expectCorrupt(
      mutatedWire(fixtureFile(), (wire) => {
        (wire.passwordSlot as Record<string, unknown>).nonce = bytesToHex(new Uint8Array(13));
      }),
    );
    expectCorrupt(
      mutatedWire(fixtureFile(), (wire) => {
        (wire.passwordSlot as Record<string, unknown>).wrappedVek = bytesToHex(
          new Uint8Array(VEK_WRAP_BYTES - 1),
        );
      }),
    );
    expectCorrupt(
      mutatedWire(fixtureFile(), (wire) => {
        (wire.biometricSlot as unknown) = { wrappedVek: bytesToHex(new Uint8Array(15)) };
      }),
    );
  });

  it("rejects a payload.ct length inconsistent with meta.wordCount", () => {
    expectCorrupt(
      mutatedWire(fixtureFile(), (wire) => {
        (wire.payload as Record<string, unknown>).ct = bytesToHex(
          new Uint8Array(secretPayloadBytes(24) + 16),
        );
      }),
    );
    expectCorrupt(
      mutatedWire(fixtureFile(), (wire) => {
        (wire.meta as Record<string, unknown>).wordCount = 13;
      }),
    );
  });

  it("caps KDF parameters BEFORE any derivation (kdf-params-out-of-range)", () => {
    const oversizedMemory = mutatedWire(fixtureFile(), (wire) => {
      (wire.kdf as Record<string, unknown>).m = 2 * 1_048_576;
    });
    try {
      parseVaultFile(oversizedMemory);
      expect.unreachable("parseVaultFile accepted 2 GiB argon2id memory");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe("kdf-params-out-of-range");
    }

    const scryptWire = mutatedWire(fixtureFile(), (wire) => {
      wire.kdf = { alg: "scrypt", logN: 21, r: 8, p: 1, salt: bytesToHex(new Uint8Array(16)) };
    });
    try {
      parseVaultFile(scryptWire);
      expect.unreachable("parseVaultFile accepted scrypt N = 2^21");
    } catch (e) {
      expect((e as VaultError).code).toBe("kdf-params-out-of-range");
    }
  });
});

describe("payload AAD (tamper-evident header)", () => {
  it("is the canonical JSON of version + kdf + both wrap slots", () => {
    const file = fixtureFile();
    // Cross-runtime contract: other implementations MUST produce these exact
    // bytes as the payload AAD (key order fixed by format.ts).
    const expected =
      '{"version":1,"kdf":{"alg":"argon2id","m":8,"t":1,"p":1,' +
      `"salt":"${bytesToHex(ARGON_KDF.salt)}"},` +
      `"passwordSlot":{"nonce":"${"11".repeat(12)}","wrappedVek":"${"22".repeat(VEK_WRAP_BYTES)}"},` +
      '"biometricSlot":null}';
    expect(textDecoder.decode(payloadAad(file))).toBe(expected);
  });

  it("flipping a kdf salt byte fails payload authentication", () => {
    const file = fixtureFile();
    const vek = randomBytes(32);
    const nonce = randomBytes(12);
    const ct = aes256GcmEncrypt(vek, nonce, textEncoder.encode("payload"), payloadAad(file));

    const tamperedSalt = file.kdf.salt.slice();
    tamperedSalt[0] = tamperedSalt[0]! ^ 0x01;
    const tampered = fixtureFile({ kdf: { ...ARGON_KDF, salt: tamperedSalt } });
    expect(() => aes256GcmDecrypt(vek, nonce, ct, payloadAad(tampered))).toThrow();

    // Sanity: the untampered AAD still authenticates.
    expect(textDecoder.decode(aes256GcmDecrypt(vek, nonce, ct, payloadAad(file)))).toBe("payload");
  });

  it("adding or removing a wrap slot fails payload authentication", () => {
    const file = fixtureFile();
    const vek = randomBytes(32);
    const nonce = randomBytes(12);
    const ct = aes256GcmEncrypt(vek, nonce, textEncoder.encode("payload"), payloadAad(file));

    const slotAdded = fixtureFile({ biometricSlot: { wrappedVek: new Uint8Array(48).fill(0x99) } });
    expect(() => aes256GcmDecrypt(vek, nonce, ct, payloadAad(slotAdded))).toThrow();

    const slotNonceAdded = fixtureFile({
      passwordSlot: {
        nonce: new Uint8Array(12).fill(0x12),
        wrappedVek: new Uint8Array(VEK_WRAP_BYTES).fill(0x22),
      },
    });
    expect(() => aes256GcmDecrypt(vek, nonce, ct, payloadAad(slotNonceAdded))).toThrow();
  });

  it("accepts a manually hex-mutated file only where authentication is not at stake", () => {
    // meta is deliberately NOT authenticated (non-secret UI hints): flipping
    // createdAt still parses — it can mislabel, never expose key material.
    const bytes = mutatedWire(fixtureFile(), (wire) => {
      (wire.meta as Record<string, unknown>).createdAt = 1;
    });
    expect(parseVaultFile(bytes).meta.createdAt).toBe(1);
  });
});

describe("hex helpers", () => {
  it("bytesToHex produces lowercase even-length hex", () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
    expect(bytesToHex(new Uint8Array(0))).toBe("");
  });
});
