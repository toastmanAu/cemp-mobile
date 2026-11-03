/**
 * Protocol version 3 (ADR 0007): sender-signed envelopes. Sign-then-encrypt,
 * the signature inside the AES-GCM plaintext, a v3 key schedule that does not
 * need the (no longer clear) sender id, and a total verifier.
 */

import { codec, deriveConversationId } from "@cemp/core";
import { afterAll, describe, expect, it } from "vitest";
import { decryptEnvelope } from "./envelope.js";
import { deriveSendAttachmentKeyV3 } from "./attachment-key.js";
import {
  ENVELOPE_V3_CONTEXT,
  openEnvelopeV3,
  sealEnvelopeV3,
  sealInnerV3Raw,
  signEnvelopeV3,
  verifyEnvelopeV3,
  type SealEnvelopeV3Params,
} from "./envelope-v3.js";
import { deriveIdentityKeys, wipeIdentityKeyBundle } from "./identity.js";
import { mldsaV2Sign, mldsaV2Verify } from "./mldsa-v2.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

const ALICE = deriveIdentityKeys(fill(0x07, 64));
const BOB = deriveIdentityKeys(fill(0x11, 64));
const ALICE_ID = fill(0xaa, 32);
const BOB_ID = fill(0xbb, 32);

function payload(overrides: Partial<codec.CempPayloadV2> = {}): codec.CempPayloadV2 {
  return {
    message_id: fill(0x16, 16),
    body_type: 0x01,
    recipient_profile_id: BOB_ID,
    text: new TextEncoder().encode("hello bob"),
    attachment_manifests: [],
    reply_to_message_id: undefined,
    reply_to_outpoint: undefined,
    receipts: [],
    receipt_request: 1,
    client_timestamp: 1_735_689_600n,
    sender_device_id: fill(0x01, 16),
    padding: fill(0x99, 4),
    ...overrides,
  };
}

function sealParams(overrides: Partial<SealEnvelopeV3Params> = {}): SealEnvelopeV3Params {
  return {
    header: { protocol_version: 3, network: 1, expiry_hint: 0n },
    senderProfileId: ALICE_ID,
    contentType: 0x01,
    createdAtClient: 1_735_689_600n,
    payload: payload(),
    recipientKemPublicKey: BOB.mlKem.publicKey,
    signerSecretKey: ALICE.mlDsa.secretKey,
    signerPublicKey: ALICE.mlDsa.publicKey,
    nonce: fill(0x0c, 12),
    kemMessage: fill(0x42, 32),
    extraEntropy: fill(0x00, 32),
    ...overrides,
  };
}

function open(envelopeBytes: Uint8Array, ownProfileId = BOB_ID) {
  return openEnvelopeV3({
    envelopeBytes,
    recipientKemSecretKey: BOB.mlKem.secretKey,
    ownProfileId,
  });
}

afterAll(() => {
  wipeIdentityKeyBundle(ALICE);
  wipeIdentityKeyBundle(BOB);
});

describe("signEnvelopeV3 / verifyEnvelopeV3 (ctx CEMP-ENVELOPE-V3, pure mode)", () => {
  const transcript = new Uint8Array(2048).fill(0x5a);

  it("the context string is exactly CEMP-ENVELOPE-V3", () => {
    expect(ENVELOPE_V3_CONTEXT).toBe("CEMP-ENVELOPE-V3");
  });

  it("signs a full transcript (no prehash) and verifies it with the signer's key", () => {
    const sig = signEnvelopeV3(ALICE.mlDsa.secretKey, transcript, fill(0, 32));
    expect(sig.length).toBe(3309);
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, transcript, sig)).toBe(true);
    // Pure mode over the transcript bytes with the v3 context, nothing else.
    expect(
      ml_dsa65.verify(sig, transcript, ALICE.mlDsa.publicKey, {
        context: new TextEncoder().encode("CEMP-ENVELOPE-V3"),
      }),
    ).toBe(true);
  });

  it("deterministic with extraEntropy = 0x00*32; hedged by default", () => {
    const a = signEnvelopeV3(ALICE.mlDsa.secretKey, transcript, fill(0, 32));
    const b = signEnvelopeV3(ALICE.mlDsa.secretKey, transcript, fill(0, 32));
    expect(a).toEqual(b);
    const hedged = signEnvelopeV3(ALICE.mlDsa.secretKey, transcript);
    expect(hedged).not.toEqual(a);
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, transcript, hedged)).toBe(true);
  });

  it("rejects another key, a mutated transcript and a mutated signature", () => {
    const sig = signEnvelopeV3(ALICE.mlDsa.secretKey, transcript, fill(0, 32));
    expect(verifyEnvelopeV3(BOB.mlDsa.publicKey, transcript, sig)).toBe(false);
    const mutated = transcript.slice();
    mutated[100] = mutated[100]! ^ 1;
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, mutated, sig)).toBe(false);
    const badSig = sig.slice();
    badSig[10] = badSig[10]! ^ 1;
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, transcript, badSig)).toBe(false);
  });

  it("is domain-separated from the CKB lock context in both directions", () => {
    const digest = fill(0x3c, 32);
    // A lock signature over a 32-byte digest never verifies as an envelope.
    const lockSig = mldsaV2Sign(ALICE.mlDsa.secretKey, digest, fill(0, 32));
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, digest, lockSig)).toBe(false);
    // An envelope signature over 32 bytes never verifies as a lock witness.
    const envSig = signEnvelopeV3(ALICE.mlDsa.secretKey, digest, fill(0, 32));
    expect(mldsaV2Verify(ALICE.mlDsa.publicKey, digest, envSig)).toBe(false);
  });

  it("is total at the trust boundary: wrong-length or garbage inputs return false", () => {
    const sig = signEnvelopeV3(ALICE.mlDsa.secretKey, transcript, fill(0, 32));
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, transcript, sig.subarray(1))).toBe(false);
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, transcript, new Uint8Array(3310))).toBe(false);
    expect(verifyEnvelopeV3(new Uint8Array(10), transcript, sig)).toBe(false);
    expect(verifyEnvelopeV3(fill(0xff, 1952), transcript, sig)).toBe(false);
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, transcript, fill(0xff, 3309))).toBe(false);
    expect(verifyEnvelopeV3(undefined as unknown as Uint8Array, transcript, sig)).toBe(false);
  });

  it("refuses to sign with a malformed secret key", () => {
    expect(() => signEnvelopeV3(new Uint8Array(32), transcript)).toThrow();
  });
});

describe("sealEnvelopeV3 / openEnvelopeV3", () => {
  it("round-trips: the inner carries sender id, conversation, payload and a valid signature", () => {
    const sealed = sealEnvelopeV3(sealParams());
    const opened = open(sealed.envelopeBytes);
    expect(opened.header).toEqual({ protocol_version: 3, network: 1, expiry_hint: 0n });
    expect(opened.inner.sender_profile_id).toEqual(ALICE_ID);
    expect(opened.inner.conversation_id).toEqual(deriveConversationId(ALICE_ID, BOB_ID));
    expect(opened.inner.payload.text).toEqual(new TextEncoder().encode("hello bob"));
    expect(opened.transcript).toEqual(sealed.transcript);
    expect(verifyEnvelopeV3(ALICE.mlDsa.publicKey, opened.transcript, opened.inner.signature)).toBe(
      true,
    );
    expect(opened.receiptKey).toEqual(sealed.receiptKey);
    expect(opened.attachmentKey).toEqual(sealed.attachmentKey);
  });

  it("nothing identifying the sender is in clear text", () => {
    const sealed = sealEnvelopeV3(sealParams());
    const { envelope } = codec.decodeCempEnvelope(sealed.envelopeBytes);
    const hex = codec.bytesToHex(sealed.envelopeBytes);
    expect(Object.keys(envelope.header).sort()).toEqual([
      "expiry_hint",
      "network",
      "protocol_version",
    ]);
    expect(hex).not.toContain(codec.bytesToHex(ALICE_ID));
    expect(hex).not.toContain(codec.bytesToHex(deriveConversationId(ALICE_ID, BOB_ID)));
    expect(hex).not.toContain(codec.bytesToHex(fill(0x16, 16)));
  });

  it("deterministic with fixed nonce, KEM message and extraEntropy", () => {
    expect(sealEnvelopeV3(sealParams()).envelopeBytes).toEqual(
      sealEnvelopeV3(sealParams()).envelopeBytes,
    );
  });

  it("refuses to seal an inner that would fail the receiver's checks", () => {
    expect(() => sealEnvelopeV3(sealParams({ contentType: 0x03 }))).toThrow(/content_type/);
  });

  it("refuses a signer key whose public half differs from the declared sender key", () => {
    expect(() => sealEnvelopeV3(sealParams({ signerPublicKey: BOB.mlDsa.publicKey }))).toThrow(
      /signer/,
    );
  });

  it("another recipient cannot open it; a tampered header fails AES-GCM", () => {
    const sealed = sealEnvelopeV3(sealParams());
    expect(() => open(sealed.envelopeBytes, fill(0xcc, 32))).toThrow();
    const decoded = codec.decodeCempEnvelopeV3(sealed.envelopeBytes);
    const tampered = codec.encodeCempEnvelopeV3({
      ...decoded,
      header: { ...decoded.header, expiry_hint: 1n },
    });
    expect(() => open(tampered)).toThrow();
  });

  /** Seal an arbitrary (possibly malformed) inner for Bob via the raw sealer. */
  function rawForBob(mutate: (inner: codec.CempInnerV3) => codec.CempInnerV3) {
    return sealInnerV3Raw({
      header: { protocol_version: 3, network: 1, expiry_hint: 0n },
      recipientKemPublicKey: BOB.mlKem.publicKey,
      kdfRecipientProfileId: BOB_ID,
      buildInner: (kemCiphertext, nonce) => {
        const base = {
          sender_profile_id: ALICE_ID,
          conversation_id: deriveConversationId(ALICE_ID, BOB_ID),
          content_type: 0x01,
          created_at_client: 1n,
          payload: payload(),
        };
        const transcript = codec.signingTranscriptV3(
          {
            header: { protocol_version: 3, network: 1, expiry_hint: 0n },
            kem_ciphertext: kemCiphertext,
            nonce,
          },
          base,
        );
        const signature = signEnvelopeV3(ALICE.mlDsa.secretKey, transcript, fill(0, 32));
        return codec.encodeCempInnerV3(
          mutate({ ...base, sig_algorithm: { family: 1, parameter: 61 }, signature }),
        );
      },
    }).envelopeBytes;
  }

  it("the raw sealer's well-formed inner opens (control for the two negatives below)", () => {
    expect(open(rawForBob((inner) => inner)).inner.sender_profile_id).toEqual(ALICE_ID);
  });

  it("open rejects recipient_profile_id ≠ me even when AES-GCM succeeds", () => {
    // The key schedule binds the id the SENDER used; a payload naming Carol
    // under Bob's id decrypts at Bob but fails the semantic binding.
    const bytes = rawForBob((inner) => ({
      ...inner,
      payload: { ...inner.payload, recipient_profile_id: fill(0xcc, 32) },
    }));
    expect(() => open(bytes)).toThrow(/recipient_profile_id/);
  });

  it("open rejects a wrong sig_algorithm before any key lookup", () => {
    const bytes = rawForBob((inner) => ({ ...inner, sig_algorithm: { family: 1, parameter: 44 } }));
    expect(() => open(bytes)).toThrow(/sig_algorithm/);
  });

  it("the sealer refuses a non-v3 header", () => {
    expect(() =>
      sealEnvelopeV3(sealParams({ header: { protocol_version: 2, network: 1, expiry_hint: 0n } })),
    ).toThrow(/protocol_version/);
  });

  it("the v1/v2 decryptEnvelope refuses a v3 envelope (one schema per version)", () => {
    const sealed = sealEnvelopeV3(sealParams());
    expect(() =>
      decryptEnvelope({
        envelopeBytes: sealed.envelopeBytes,
        recipientKemSecretKey: BOB.mlKem.secretKey,
        ownProfileId: BOB_ID,
      }),
    ).toThrow(/protocol_version 3/);
  });

  it("openEnvelopeV3 refuses a v1/v2 envelope", () => {
    const v1 = codec.encodeCempEnvelopeV1(codec.buildEnvelope(false));
    expect(() => open(v1)).toThrow(/protocol_version/);
  });

  it("the image path's pre-derived attachment key equals the sealed one", () => {
    const key = deriveSendAttachmentKeyV3({
      recipientKemPublicKey: BOB.mlKem.publicKey,
      kemMessage: fill(0x42, 32),
      nonce: fill(0x0c, 12),
      recipientProfileId: BOB_ID,
    });
    expect(key).toEqual(sealEnvelopeV3(sealParams()).attachmentKey);
  });
});
