/**
 * The keyed path (payload decryption) — deliberately separate from the
 * structural decoders. A debug tool is not an exemption from rule 2:
 * plaintext is shown ONLY behind the explicit --show-plaintext flag, and
 * the default view reports lengths, never content.
 */

import { codec } from "@cemp/core";
import { decryptEnvelope } from "@cemp/crypto";

export interface PayloadView {
  bodyType: number;
  textLength: number | null;
  /** Present ONLY with --show-plaintext. */
  text?: string;
  attachmentManifestCount: number;
  receipts: readonly { messageId: string; status: number }[];
  replyToMessageId: string | null;
  clientTimestamp: string;
  senderDeviceId: string;
  paddingBytes: number;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DecryptPayloadInput {
  envelopeBytes: Uint8Array;
  /** Own ML-KEM-768 secret key (hex, 2400 bytes) — from the ENV, never argv. */
  kemSecretKeyHex: string;
  /** Own profile id (hex, 32 bytes). */
  ownProfileIdHex: string;
  showPlaintext: boolean;
}

function hexToBytes(hex: string, expected: number, label: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-f]*$/i.test(bare) || bare.length !== expected * 2) {
    throw new Error(`${label} must be ${expected} bytes of hex`);
  }
  const out = new Uint8Array(expected);
  for (let i = 0; i < expected; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/** Decrypt and view a payload. The secret key buffer is wiped before return. */
export function decryptPayloadView(input: DecryptPayloadInput): PayloadView {
  const secretKey = hexToBytes(input.kemSecretKeyHex, 2400, "kem secret key");
  try {
    const { header, payloadBytes } = decryptEnvelope({
      envelopeBytes: input.envelopeBytes,
      recipientKemSecretKey: secretKey,
      ownProfileId: hexToBytes(input.ownProfileIdHex, 32, "own profile id"),
    });
    const payloadCheck = codec.validatePayload(payloadBytes);
    if (!payloadCheck.ok) {
      throw new Error(`payload rejected: ${payloadCheck.reason}`);
    }
    const consistency = codec.validateSemanticConsistency(
      header,
      codec.decodeCempPayloadV1(payloadBytes),
      hexToBytes(input.ownProfileIdHex, 32, "own profile id"),
    );
    if (!consistency.ok) {
      throw new Error(`header/payload mismatch: ${consistency.reason}`);
    }
    const payload = codec.decodeCempPayloadV1(payloadBytes);
    const view: PayloadView = {
      bodyType: payload.body_type,
      textLength: payload.text === undefined ? null : payload.text.length,
      attachmentManifestCount: payload.attachment_manifests.length,
      receipts: payload.receipts.map((receipt) => ({
        messageId: `0x${bytesToHex(receipt.message_id)}`,
        status: receipt.status,
      })),
      replyToMessageId:
        payload.reply_to_message_id === undefined
          ? null
          : `0x${bytesToHex(payload.reply_to_message_id)}`,
      clientTimestamp: payload.client_timestamp.toString(),
      senderDeviceId: `0x${bytesToHex(payload.sender_device_id)}`,
      paddingBytes: payload.padding.length,
    };
    if (input.showPlaintext && payload.text !== undefined) {
      view.text = new TextDecoder().decode(payload.text);
    }
    return view;
  } finally {
    secretKey.fill(0);
  }
}
