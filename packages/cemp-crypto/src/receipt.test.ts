import { codec } from "@cemp/core";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/cemp-v2-receipt.json";
import { MESSAGE_KEY_DOMAIN, RECEIPT_PROOF_DOMAIN } from "./domains.js";
import { decryptEnvelope, encryptEnvelope } from "./envelope.js";
import { deriveMessageKey } from "./hkdf.js";
import {
  computeReceiptProof,
  deriveReceiptKey,
  RECEIPT_PROOF_BYTES,
  verifyReceiptProof,
} from "./receipt.js";

const { bytesToHex, hexToBytes } = codec;

describe("ADR 0006 domains", () => {
  it("registers the receipt key and proof domains, distinct from the message/attachment keys", () => {
    expect(MESSAGE_KEY_DOMAIN.ReceiptKey).toBe("CEMP-RECEIPT-KEY-V1");
    expect(RECEIPT_PROOF_DOMAIN).toBe("CEMP-RECEIPT-PROOF-V1");
    const all = [...Object.values(MESSAGE_KEY_DOMAIN), RECEIPT_PROOF_DOMAIN];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("cemp-v2-receipt known-answer vectors (independent Python oracle)", () => {
  for (const c of vectors.cases) {
    const secret = hexToBytes(c.mlKemSharedSecret);
    const nonce = hexToBytes(c.envelopeNonce);
    const sender = hexToBytes(c.senderProfileId);
    const recipient = hexToBytes(c.recipientProfileId);
    const messageId = hexToBytes(c.messageId);

    it(`${c.name}: the oracle's HKDF agrees with deriveMessageKey (oracle sanity)`, () => {
      expect(bytesToHex(deriveMessageKey(secret, nonce, sender, recipient))).toBe(c.messageKey);
    });

    it(`${c.name}: receipt_key`, () => {
      expect(bytesToHex(deriveReceiptKey(secret, nonce, sender, recipient))).toBe(c.receiptKey);
    });

    for (const p of c.proofs) {
      it(`${c.name}: proof for status 0x0${p.status}`, () => {
        const key = hexToBytes(c.receiptKey);
        expect(bytesToHex(computeReceiptProof(key, messageId, p.status))).toBe(p.proof);
        expect(verifyReceiptProof(key, messageId, p.status, hexToBytes(p.proof))).toBe(true);
      });
    }
  }
});

describe("verifyReceiptProof rejects", () => {
  const key = new Uint8Array(32).fill(0x42);
  const messageId = new Uint8Array(16).fill(0x07);
  const proof = computeReceiptProof(key, messageId, 0x01);

  it("a proof for another status (0x01 relabelled 0x05)", () => {
    expect(verifyReceiptProof(key, messageId, 0x05, proof)).toBe(false);
  });

  it("a proof for another message", () => {
    expect(verifyReceiptProof(key, new Uint8Array(16).fill(0x08), 0x01, proof)).toBe(false);
  });

  it("a proof under another key", () => {
    expect(verifyReceiptProof(new Uint8Array(32).fill(0x43), messageId, 0x01, proof)).toBe(false);
  });

  it("a single flipped bit", () => {
    const flipped = proof.slice();
    flipped[31] = flipped[31]! ^ 0x01;
    expect(verifyReceiptProof(key, messageId, 0x01, flipped)).toBe(false);
  });

  it("wrong lengths, without throwing", () => {
    expect(verifyReceiptProof(key, messageId, 0x01, proof.subarray(0, 31))).toBe(false);
    expect(verifyReceiptProof(key, messageId, 0x01, new Uint8Array(0))).toBe(false);
    expect(verifyReceiptProof(key.subarray(0, 16), messageId, 0x01, proof)).toBe(false);
    expect(verifyReceiptProof(key, messageId.subarray(0, 15), 0x01, proof)).toBe(false);
    expect(verifyReceiptProof(key, messageId, 256, proof)).toBe(false);
  });

  it("an all-zero proof", () => {
    expect(verifyReceiptProof(key, messageId, 0x01, new Uint8Array(RECEIPT_PROOF_BYTES))).toBe(
      false,
    );
  });
});

describe("computeReceiptProof input checks", () => {
  it("throws on a wrong-length key, message id, or out-of-range status", () => {
    const messageId = new Uint8Array(16);
    expect(() => computeReceiptProof(new Uint8Array(31), messageId, 1)).toThrow();
    expect(() => computeReceiptProof(new Uint8Array(32), new Uint8Array(17), 1)).toThrow();
    expect(() => computeReceiptProof(new Uint8Array(32), messageId, -1)).toThrow();
    expect(() => computeReceiptProof(new Uint8Array(32), messageId, 0x100)).toThrow();
    expect(() => computeReceiptProof(new Uint8Array(32), messageId, 1.5)).toThrow();
  });
});

describe("encryptEnvelope / decryptEnvelope return the receipt key", () => {
  it("sender and recipient derive the byte-identical receipt key, distinct from the attachment key", () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const sender = new Uint8Array(32).fill(1);
    const recipient = new Uint8Array(32).fill(2);
    const messageId = new Uint8Array(16).fill(9);
    const payload = codec.encodeCempPayloadV2({
      message_id: messageId,
      body_type: 0x01,
      recipient_profile_id: recipient,
      text: new TextEncoder().encode("hi"),
      attachment_manifests: [],
      receipts: [],
      receipt_request: 1,
      client_timestamp: 0n,
      sender_device_id: new Uint8Array(16).fill(7),
      padding: new Uint8Array(0),
    });
    const header: codec.CempEnvelopeHeaderV1Encodable = {
      protocol_version: 2,
      network: 0x01,
      content_type: 0x01,
      message_id: messageId,
      conversation_id: new Uint8Array(32).fill(3),
      sender_profile_id: sender,
      created_at_client: 0n,
      expiry_hint: 0n,
    };
    const sealed = encryptEnvelope({ payload, recipientKemPublicKey: publicKey, header });
    const opened = decryptEnvelope({
      envelopeBytes: sealed.envelopeBytes,
      recipientKemSecretKey: secretKey,
      ownProfileId: recipient,
    });
    expect(sealed.receiptKey).toHaveLength(32);
    expect(bytesToHex(opened.receiptKey)).toBe(bytesToHex(sealed.receiptKey));
    expect(bytesToHex(sealed.receiptKey)).not.toBe(bytesToHex(sealed.attachmentKey));
    // A proof made by the recipient verifies against the sender's copy.
    const proof = computeReceiptProof(opened.receiptKey, messageId, 0x01);
    expect(verifyReceiptProof(sealed.receiptKey, messageId, 0x01, proof)).toBe(true);
  });
});
