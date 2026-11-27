/**
 * Deterministic protocol-version-2 codec fixtures (ADR 0006). Same rules as
 * `fixtures.ts`: fixed fill bytes and timestamps only, so the v2 golden
 * vectors regenerate byte-for-byte. Covers the receipt-only (64 receipts,
 * 255 B padding) and content-plus-receipt boundaries.
 */

import type { BytesLike } from "@ckb-ccc/core";
import { CONTENT_TYPE } from "../envelope.js";
import {
  decodeCempPayloadV2,
  decodeReceiptEntryV2,
  encodeCempPayloadV2,
  encodeReceiptEntryV2,
} from "./codecs.js";
import type { CempPayloadV2, ReceiptEntryV2 } from "./codecs.js";
import { buildPayloadText, FIXED_UNIX_SECONDS, type FixtureEntry } from "./fixtures.js";

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

/** Not a real proof: fixtures pin serialization bytes only. */
export function buildReceiptEntryV2(seed: number, status = 0x01): ReceiptEntryV2 {
  return { message_id: fill(seed, 16), status, proof: fill(seed ^ 0xa5, 32) };
}

function payloadV2Base(): CempPayloadV2 {
  return {
    message_id: fill(0x16, 16),
    body_type: CONTENT_TYPE.Text,
    recipient_profile_id: fill(0x22, 32),
    text: undefined,
    attachment_manifests: [],
    reply_to_message_id: undefined,
    reply_to_outpoint: undefined,
    receipts: [],
    receipt_request: 0x00,
    client_timestamp: FIXED_UNIX_SECONDS,
    sender_device_id: fill(0x44, 16),
    padding: new Uint8Array(0),
  };
}

/** Text message carrying one proven receipt (content + ack). */
export function buildPayloadV2Text(): CempPayloadV2 {
  const v1 = buildPayloadText();
  return {
    ...payloadV2Base(),
    text: v1.text,
    receipts: [buildReceiptEntryV2(0x51)],
    receipt_request: 0x01,
    padding: fill(0x99, 8),
  };
}

/** Receipt-only ack (empty text, as the app sends it): 64 receipts, 255 B padding. */
export function buildPayloadV2ReceiptMax(): CempPayloadV2 {
  return {
    ...payloadV2Base(),
    text: new Uint8Array(0),
    receipts: Array.from({ length: 64 }, (_, i) => buildReceiptEntryV2(i, (i % 6) + 1)),
    padding: fill(0x77, 255),
  };
}

/** No receipts at all (plain v2 content message). */
export function buildPayloadV2NoReceipts(): CempPayloadV2 {
  return { ...payloadV2Base(), text: new TextEncoder().encode("hello v2") };
}

function defineFixture<T>(
  name: string,
  structure: string,
  value: T,
  codec: { encode: (value: T) => Uint8Array; decode: (data: BytesLike) => T },
): FixtureEntry {
  return { name, structure, value, encode: codec.encode, decode: codec.decode };
}

/** All v2 fixtures, in golden-vector order. */
export const CODEC_FIXTURES_V2: readonly FixtureEntry[] = [
  defineFixture("receipt-entry-v2", "ReceiptEntryV2", buildReceiptEntryV2(0x51, 0x01), {
    encode: encodeReceiptEntryV2,
    decode: decodeReceiptEntryV2,
  }),
  defineFixture("payload-v2-text-with-receipt", "CempPayloadV2", buildPayloadV2Text(), {
    encode: encodeCempPayloadV2,
    decode: decodeCempPayloadV2,
  }),
  defineFixture("payload-v2-receipt-max", "CempPayloadV2", buildPayloadV2ReceiptMax(), {
    encode: encodeCempPayloadV2,
    decode: decodeCempPayloadV2,
  }),
  defineFixture("payload-v2-no-receipts", "CempPayloadV2", buildPayloadV2NoReceipts(), {
    encode: encodeCempPayloadV2,
    decode: decodeCempPayloadV2,
  }),
];
