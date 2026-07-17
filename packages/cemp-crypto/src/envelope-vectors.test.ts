import { codec } from "@cemp/core";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/cemp-v1-envelope.json";
import { decryptEnvelope, encryptEnvelope } from "./envelope.js";
import { deriveIdentityKeys } from "./identity.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Golden envelope vectors (spec §14): fixed seed identities, fixed nonce and
 * fixed FIPS-203 encapsulation message make encryption fully deterministic.
 * Regenerate with `pnpm --filter @cemp/crypto exec tsx src/vectors-generate.ts`.
 */
describe("cemp-v1-envelope golden vectors", () => {
  it("has the expected suite shape", () => {
    expect(vectors.suite).toBe("cemp-v1-envelope");
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const c of vectors.cases) {
    it(`reproduces and round-trips case "${c.name}"`, () => {
      const recipient = deriveIdentityKeys(codec.hexToBytes(c.recipientSeed));
      const header = codec.decodeCempEnvelopeHeaderV1(codec.hexToBytes(c.headerBytes));

      const result = encryptEnvelope({
        payload: codec.hexToBytes(c.payloadBytes),
        recipientKemPublicKey: recipient.mlKem.publicKey,
        header,
        nonce: codec.hexToBytes(c.nonce),
        kemMessage: codec.hexToBytes(c.kemMessage),
      });
      // Byte-for-byte reproduction (spec §14 envelope end-to-end vector).
      expect(bytesToHex(result.envelopeBytes)).toBe(c.envelopeBytes);
      expect(bytesToHex(result.kemCiphertext)).toBe(c.kemCiphertext);

      // Decrypt round-trip against the recorded bytes.
      const ownProfileId = codec.decodeCempPayloadV1(
        codec.hexToBytes(c.payloadBytes),
      ).recipient_profile_id;
      const opened = decryptEnvelope({
        envelopeBytes: codec.hexToBytes(c.envelopeBytes),
        recipientKemSecretKey: recipient.mlKem.secretKey,
        ownProfileId,
      });
      expect(bytesToHex(opened.payloadBytes)).toBe(c.payloadBytes);
      expect(bytesToHex(codec.encodeCempEnvelopeHeaderV1(opened.header))).toBe(c.headerBytes);
    });
  }
});
