/**
 * Deterministic protocol-version-3 codec fixtures (ADR 0007). Same rules as
 * `fixtures.ts`: fixed fill bytes and timestamps only, so the v3 golden
 * vectors regenerate byte-for-byte. The signature bytes here are fill bytes,
 * not real signatures: these fixtures pin SERIALIZATION only. Real
 * known-answer signatures live in `cemp-v3-envelope.json` (cemp-crypto).
 */

import type { BytesLike } from "@ckb-ccc/core";
import {
  decodeCempEnvelopeHeaderV3,
  decodeCempEnvelopeV3,
  decodeCempInnerV3,
  decodeCempSigningTranscriptV3,
  encodeCempEnvelopeHeaderV3,
  encodeCempEnvelopeV3,
  encodeCempInnerV3,
  encodeCempSigningTranscriptV3,
  MLDSA65_SIGNATURE_BYTES,
} from "./codecs.js";
import type {
  CempPayloadV2,
  CempEnvelopeHeaderV3,
  CempEnvelopeV3,
  CempInnerV3,
  CempSigningTranscriptV3,
} from "./codecs.js";
import { FIXED_UNIX_SECONDS, type FixtureEntry } from "./fixtures.js";
import {
  buildPayloadV2NoReceipts,
  buildPayloadV2ReceiptMax,
  buildPayloadV2Text,
} from "./fixtures-v2.js";

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

export function buildEnvelopeHeaderV3(): CempEnvelopeHeaderV3 {
  return { protocol_version: 3, network: 0x01, expiry_hint: FIXED_UNIX_SECONDS + 86_400n };
}

/** A v3 inner plaintext around `payload` with a fill-byte (not real) signature. */
export function buildInnerV3(payload: CempPayloadV2 = buildPayloadV2Text()): CempInnerV3 {
  return {
    sender_profile_id: fill(0x33, 32),
    conversation_id: fill(0x55, 32),
    content_type: payload.body_type,
    created_at_client: FIXED_UNIX_SECONDS,
    payload,
    sig_algorithm: { family: 0x01, parameter: 61 },
    signature: fill(0x5d, MLDSA65_SIGNATURE_BYTES),
  };
}

export function buildEnvelopeV3(): CempEnvelopeV3 {
  return {
    header: buildEnvelopeHeaderV3(),
    kem_ciphertext: fill(0x6b, 1088),
    nonce: fill(0x0c, 12),
    // Ciphertext bytes are opaque to the codec; fill bytes + a 16-byte "tag".
    encrypted_payload: fill(0xe3, 4096),
  };
}

export function buildSigningTranscriptV3(
  inner: CempInnerV3 = buildInnerV3(),
): CempSigningTranscriptV3 {
  const envelope = buildEnvelopeV3();
  return {
    header: envelope.header,
    kem_ciphertext: envelope.kem_ciphertext,
    nonce: envelope.nonce,
    sender_profile_id: inner.sender_profile_id,
    conversation_id: inner.conversation_id,
    content_type: inner.content_type,
    created_at_client: inner.created_at_client,
    payload: inner.payload,
  };
}

function defineFixture<T>(
  name: string,
  structure: string,
  value: T,
  codec: { encode: (value: T) => Uint8Array; decode: (data: BytesLike) => T },
): FixtureEntry {
  return { name, structure, value, encode: codec.encode, decode: codec.decode };
}

const headerCodec = { encode: encodeCempEnvelopeHeaderV3, decode: decodeCempEnvelopeHeaderV3 };
const innerCodec = { encode: encodeCempInnerV3, decode: decodeCempInnerV3 };

/** All v3 fixtures, in golden-vector order. */
export const CODEC_FIXTURES_V3: readonly FixtureEntry[] = [
  defineFixture("envelope-header-v3", "CempEnvelopeHeaderV3", buildEnvelopeHeaderV3(), headerCodec),
  defineFixture("envelope-v3", "CempEnvelopeV3", buildEnvelopeV3(), {
    encode: encodeCempEnvelopeV3,
    decode: decodeCempEnvelopeV3,
  }),
  defineFixture("inner-v3-text-with-receipt", "CempInnerV3", buildInnerV3(), innerCodec),
  defineFixture(
    "inner-v3-receipt-max",
    "CempInnerV3",
    buildInnerV3(buildPayloadV2ReceiptMax()),
    innerCodec,
  ),
  defineFixture(
    "inner-v3-no-receipts",
    "CempInnerV3",
    buildInnerV3(buildPayloadV2NoReceipts()),
    innerCodec,
  ),
  defineFixture("signing-transcript-v3", "CempSigningTranscriptV3", buildSigningTranscriptV3(), {
    encode: encodeCempSigningTranscriptV3,
    decode: decodeCempSigningTranscriptV3,
  }),
];
