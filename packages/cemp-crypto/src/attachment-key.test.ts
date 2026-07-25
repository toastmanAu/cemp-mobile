import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { describe, expect, it } from "vitest";
import { deriveSendAttachmentKey } from "./attachment-key.js";
import { encryptEnvelope, decryptEnvelope } from "./envelope.js";
import { randomBytes } from "./random.js";
import { codec } from "@cemp/core";

describe("deriveSendAttachmentKey", () => {
  it("matches the attachmentKey a receiver derives from the same encapsulation", () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const senderProfileId = new Uint8Array(32).fill(1);
    const recipientProfileId = new Uint8Array(32).fill(2);
    const kemMessage = randomBytes(32);
    const nonce = randomBytes(12);

    const sendKey = deriveSendAttachmentKey({
      recipientKemPublicKey: publicKey,
      kemMessage,
      nonce,
      senderProfileId,
      recipientProfileId,
    });

    // Build a real envelope reusing the SAME kemMessage+nonce (the §6 seam),
    // then decrypt it and confirm the receiver derives the byte-identical key.
    const messageId = new Uint8Array(16).fill(9);
    const payload = codec.encodeCempPayloadV1({
      message_id: messageId,
      body_type: 0x03,
      recipient_profile_id: recipientProfileId,
      attachment_manifests: [],
      receipts: [],
      receipt_request: 0,
      client_timestamp: 0n,
      sender_device_id: new Uint8Array(16).fill(7),
      padding: new Uint8Array(0),
    });
    const header: codec.CempEnvelopeHeaderV1Encodable = {
      protocol_version: 1,
      network: 0x01,
      content_type: 0x03,
      message_id: messageId,
      conversation_id: new Uint8Array(32).fill(3),
      sender_profile_id: senderProfileId,
      created_at_client: 0n,
      expiry_hint: 0n,
    };
    const env = encryptEnvelope({
      payload,
      recipientKemPublicKey: publicKey,
      header,
      kemMessage,
      nonce,
    });
    const dec = decryptEnvelope({
      envelopeBytes: env.envelopeBytes,
      recipientKemSecretKey: secretKey,
      ownProfileId: recipientProfileId,
    });
    expect(Array.from(sendKey)).toEqual(Array.from(dec.attachmentKey));
    expect(sendKey.length).toBe(32);
  });

  it("rejects a wrong-length kemMessage", () => {
    expect(() =>
      deriveSendAttachmentKey({
        recipientKemPublicKey: ml_kem768.keygen().publicKey,
        kemMessage: new Uint8Array(16),
        nonce: new Uint8Array(12),
        senderProfileId: new Uint8Array(32),
        recipientProfileId: new Uint8Array(32),
      }),
    ).toThrow();
  });
});
