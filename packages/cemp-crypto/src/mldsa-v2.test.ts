import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import {
  MLDSA_V2_SIZES,
  buildFinalMessage,
  cighashV2Digest,
  mldsaV2KeygenFromSeed,
  mldsaV2LockArgs,
  mldsaV2Sign,
  mldsaV2Verify,
  mldsaV2WitnessLock,
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

describe("mldsa-v2 golden vectors (tools/signing-harness, fips204)", () => {
  describe("keygen + lock args", () => {
    for (const kc of vectors.keygen) {
      it(`noble keygen matches fips204 keygen_from_seed byte-for-byte (${kc.name})`, () => {
        const { publicKey, secretKey } = mldsaV2KeygenFromSeed(hexToBytes(kc.seed));
        expect(publicKey).toHaveLength(MLDSA_V2_SIZES.pk);
        expect(secretKey).toHaveLength(MLDSA_V2_SIZES.sk);
        expect(bytesToHex(publicKey)).toBe(kc.pubkey);
        expect(bytesToHex(secretKey)).toBe(kc.secretKey);
      });

      it(`lock args match (${kc.name})`, () => {
        const args = mldsaV2LockArgs(hexToBytes(kc.pubkey));
        expect(args).toHaveLength(MLDSA_V2_SIZES.lockArgs);
        expect(bytesToHex(args)).toBe(kc.lockArgs);
      });
    }
  });

  describe("cighash digest + final message", () => {
    for (const cc of vectors.cighash) {
      it(`digest matches blake2b-256 personal "ckb-mldsa-msg" (${cc.name})`, () => {
        expect(bytesToHex(cighashV2Digest(hexToBytes(cc.stream)))).toBe(cc.digest);
      });

      it(`final message is 0x00 || 0x0E || "CKB-MLDSA-LOCK" || digest (${cc.name})`, () => {
        expect(bytesToHex(buildFinalMessage(hexToBytes(cc.digest)))).toBe(cc.finalMessage);
      });
    }
  });

  describe("sign", () => {
    for (const sc of vectors.sign) {
      const secretKey = mldsaV2KeygenFromSeed(hexToBytes(sc.seed)).secretKey;
      const digest = hexToBytes(sc.digest);

      it(`deterministic sign (rnd = 0x00*32) matches byte-for-byte (${sc.name})`, () => {
        const signature = mldsaV2Sign(secretKey, digest, new Uint8Array(32));
        expect(signature).toHaveLength(MLDSA_V2_SIZES.sig);
        expect(bytesToHex(signature)).toBe(sc.signature);
      });

      it(`witness lock is [0x7B, pubkey, sig] (${sc.name})`, () => {
        const witnessLock = mldsaV2WitnessLock(hexToBytes(sc.pubkey), hexToBytes(sc.signature));
        expect(witnessLock).toHaveLength(MLDSA_V2_SIZES.witnessLock);
        expect(witnessLock[0]).toBe(0x7b);
        expect(bytesToHex(witnessLock)).toBe(sc.witnessLock);
      });

      it(`hedged sign (no random) verifies and differs from the deterministic sig (${sc.name})`, () => {
        const hedged = mldsaV2Sign(secretKey, digest);
        expect(mldsaV2Verify(hexToBytes(sc.pubkey), digest, hedged)).toBe(true);
        expect(bytesToHex(hedged)).not.toBe(sc.signature);
      });

      it(`deterministic sig verifies under mldsaV2Verify (${sc.name})`, () => {
        expect(mldsaV2Verify(hexToBytes(sc.pubkey), digest, hexToBytes(sc.signature))).toBe(true);
      });
    }
  });
});
