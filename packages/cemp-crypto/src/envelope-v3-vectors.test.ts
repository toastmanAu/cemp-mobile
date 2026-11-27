/**
 * cemp-v3-envelope golden vectors (ADR 0007 test plan): the committed file
 * equals a fresh deterministic build, every signature case verifies exactly
 * as recorded, and every envelope case opens (or is refused) as recorded.
 * The independent Rust cross-check lives in envelope-v3.interop.test.ts.
 */

import { codec } from "@cemp/core";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/cemp-v3-envelope.json";
import { openEnvelopeV3, verifyEnvelopeV3 } from "./envelope-v3.js";
import { buildEnvelopeV3Vectors, type EnvelopeV3VectorFile } from "./envelope-v3-vectors.js";
import { deriveIdentityKeys } from "./identity.js";
import { mldsaV2Verify } from "./mldsa-v2.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

const file = vectors as EnvelopeV3VectorFile;
const hex = codec.hexToBytes;

describe("cemp-v3-envelope vectors", () => {
  it("the committed file is exactly what the deterministic builder produces", () => {
    expect(JSON.stringify(buildEnvelopeV3Vectors(), null, 2)).toBe(JSON.stringify(file, null, 2));
  });

  it("covers the ADR 0007 test plan", () => {
    const names = file.signature.map((c) => c.name);
    for (const required of [
      "positive-text",
      "positive-image",
      "positive-receipt-only",
      "wrong-key",
      "kem-ciphertext-swap",
      "lock-context-replay",
      "short-signature",
      "long-signature",
      "mutated-sender_profile_id",
      "mutated-payload.recipient_profile_id",
    ]) {
      expect(names).toContain(required);
    }
    expect(names.some((n) => n.startsWith("wrong-context"))).toBe(true);
    const envelopeNames = file.envelope.map((c) => c.name);
    for (const required of [
      "envelope-text",
      "envelope-image",
      "envelope-receipt-only",
      "envelope-wrong-sig-algorithm",
      "envelope-recipient-not-me",
    ]) {
      expect(envelopeNames).toContain(required);
    }
  });

  for (const c of file.signature) {
    it(`signature ${c.name}: verifies = ${String(c.expectVerify)}`, () => {
      const verify =
        c.verifyContext === "CEMP-ENVELOPE-V3"
          ? verifyEnvelopeV3(hex(c.publicKey), hex(c.transcript), hex(c.signature))
          : (() => {
              // The lock-context direction: the transcript is a 32-byte digest.
              const digest = hex(c.transcript);
              return mldsaV2Verify(hex(c.publicKey), digest, hex(c.signature));
            })();
      expect(verify).toBe(c.expectVerify);
    });
  }

  it("known-answer signatures re-verify under the context they were made with", () => {
    for (const c of file.signature.filter((s) => s.knownAnswer)) {
      const message = hex(c.signedMessage ?? c.transcript);
      const ok = ml_dsa65.verify(hex(c.signature), message, hex(c.publicKey), {
        context: new TextEncoder().encode(c.signContext),
      });
      // wrong-key uses another verifier key on purpose.
      expect(ok).toBe(c.name !== "wrong-key");
    }
  });

  for (const c of file.envelope) {
    it(`envelope ${c.name}: ${c.expect}`, () => {
      const recipient = deriveIdentityKeys(hex(c.recipientSeed));
      const run = () =>
        openEnvelopeV3({
          envelopeBytes: hex(c.envelopeBytes),
          recipientKemSecretKey: recipient.mlKem.secretKey,
          ownProfileId: hex(c.recipientProfileId),
        });
      if (c.expect === "reject") {
        expect(run).toThrow(c.rejectReason);
        return;
      }
      const opened = run();
      expect(codec.bytesToHex(opened.transcript)).toBe(c.transcript);
      expect(codec.bytesToHex(codec.encodeCempInnerV3(opened.inner))).toBe(c.innerBytes);
      expect(codec.bytesToHex(opened.inner.sender_profile_id)).toBe(c.senderProfileId);
      expect(
        verifyEnvelopeV3(hex(c.senderPublicKey!), opened.transcript, opened.inner.signature),
      ).toBe(true);
    });
  }
});
