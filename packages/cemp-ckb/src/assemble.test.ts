import { describe, expect, it } from "vitest";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { deriveSendAttachmentKey } from "@cemp/crypto";
import { decryptEnvelope, randomBytes } from "@cemp/crypto";
import { codec } from "@cemp/core";
import { assembleTextMessage } from "./assemble.js";

describe("assembleTextMessage attachmentEnvelope coordination", () => {
  it("derives an attachmentKey the receiver reproduces", () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const sender = new Uint8Array(32).fill(1);
    const recipient = new Uint8Array(32).fill(2);
    const kemMessage = randomBytes(32);
    const nonce = randomBytes(12);

    const assembled = assembleTextMessage({
      text: "",
      senderProfileId: sender,
      recipientProfileId: recipient,
      recipientKemPublicKey: publicKey,
      senderDeviceId: new Uint8Array(16).fill(7),
      contentType: 0x03,
      attachmentManifests: [],
      attachmentEnvelope: { kemMessage, nonce },
      nowMs: 0,
    });

    const expected = deriveSendAttachmentKey({
      recipientKemPublicKey: publicKey,
      kemMessage,
      nonce,
      senderProfileId: sender,
      recipientProfileId: recipient,
    });
    expect(Array.from(assembled.attachmentKey)).toEqual(Array.from(expected));

    const dec = decryptEnvelope({
      envelopeBytes: assembled.envelopeBytes,
      recipientKemSecretKey: secretKey,
      ownProfileId: recipient,
    });
    expect(Array.from(dec.attachmentKey)).toEqual(Array.from(expected));
  });
});

describe("assembleTextMessage sends protocol version 2 (ADR 0006)", () => {
  const { publicKey, secretKey } = ml_kem768.keygen();
  const base = {
    senderProfileId: new Uint8Array(32).fill(1),
    recipientProfileId: new Uint8Array(32).fill(2),
    recipientKemPublicKey: publicKey,
    senderDeviceId: new Uint8Array(16).fill(7),
  };

  for (const [label, extra] of [
    ["content", { text: "hello" }],
    [
      "receipt-only",
      {
        text: "",
        receipts: [{ messageId: new Uint8Array(16).fill(4), status: 1, proof: randomBytes(32) }],
      },
    ],
    [
      "content + receipt",
      {
        text: "reply",
        receipts: [{ messageId: new Uint8Array(16).fill(4), status: 1, proof: randomBytes(32) }],
      },
    ],
  ] as const) {
    it(`${label}: header v2, CempPayloadV2 carrying each proof, receipt key returned`, () => {
      const assembled = assembleTextMessage({ ...base, ...extra });
      const opened = decryptEnvelope({
        envelopeBytes: assembled.envelopeBytes,
        recipientKemSecretKey: secretKey,
        ownProfileId: base.recipientProfileId,
      });
      expect(opened.header.protocol_version).toBe(2);
      const payload = codec.decodeCempPayloadV2(opened.payloadBytes);
      const sent = "receipts" in extra ? extra.receipts : [];
      expect(payload.receipts.map((r) => Array.from(r.proof))).toEqual(
        sent.map((r) => Array.from(r.proof)),
      );
      expect(Array.from(assembled.receiptKey)).toEqual(Array.from(opened.receiptKey));
    });
  }

  it("refuses a receipt whose proof is not 32 bytes", () => {
    expect(() =>
      assembleTextMessage({
        ...base,
        text: "",
        receipts: [{ messageId: new Uint8Array(16), status: 1, proof: new Uint8Array(0) }],
      }),
    ).toThrow(/proof/);
  });
});
