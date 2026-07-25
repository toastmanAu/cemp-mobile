import { describe, expect, it } from "vitest";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { deriveSendAttachmentKey } from "@cemp/crypto";
import { decryptEnvelope, randomBytes } from "@cemp/crypto";
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
      recipientKemPublicKey: publicKey, kemMessage, nonce,
      senderProfileId: sender, recipientProfileId: recipient,
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
