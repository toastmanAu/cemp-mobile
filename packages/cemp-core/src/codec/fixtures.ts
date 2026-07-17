/**
 * Deterministic CEMP v1 codec fixtures (spec §14).
 *
 * Every value below is built from fixed fill bytes and fixed timestamps — no
 * randomness, no wall-clock — so the golden vectors generated from them are
 * reproducible byte-for-byte. The corpus covers both arms of every Option
 * field and the §11 limit boundaries (text exactly 16,384 B, padding 0 and
 * 255 B, receipts 0 and 64 entries, manifests 0 and 4, handle 64 B,
 * supported_protocol_versions 8 entries).
 */

import { CONTENT_TYPE } from "../envelope.js";
import type { BytesLike } from "@ckb-ccc/core";
import {
  encodeAttachmentManifestV1,
  encodeCempEnvelopeHeaderV1,
  encodeCempEnvelopeV1,
  encodeCempPayloadV1,
  encodeCempProfileV1,
  encodeOutPointV1,
  encodeReceiptEntryV1,
  encodeReclaimGroupV1,
  decodeAttachmentManifestV1,
  decodeCempEnvelopeHeaderV1,
  decodeCempEnvelopeV1,
  decodeCempPayloadV1,
  decodeCempProfileV1,
  decodeOutPointV1,
  decodeReceiptEntryV1,
  decodeReclaimGroupV1,
} from "./codecs.js";
import type {
  AttachmentManifestV1,
  CempEnvelopeHeaderV1,
  CempEnvelopeV1,
  CempPayloadV1,
  CempProfileV1,
  OutPointV1,
  ReceiptEntryV1,
  ReclaimGroupV1,
} from "./codecs.js";

/** 2025-01-01T00:00:00Z — fixed fixture timestamp. */
export const FIXED_UNIX_SECONDS = 1_735_689_600n;
/** FIXED_UNIX_SECONDS + 24h — fixed expiry hint. */
export const FIXED_UNIX_SECONDS_LATER = 1_735_776_000n;

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── shared building blocks ──────────────────────────────────────────────────

export function buildOutPoint(seed: number): OutPointV1 {
  return { tx_hash: fill(seed, 32), index: seed };
}

export function buildReceiptEntry(seed: number, status = 0x01): ReceiptEntryV1 {
  return { message_id: fill(seed, 16), status };
}

export function buildReceipts(count: number): ReceiptEntryV1[] {
  return Array.from({ length: count }, (_, i) => buildReceiptEntry(i, (i % 6) + 1));
}

export function buildAttachmentManifest(options: {
  seed: number;
  withThumbnail: boolean;
  chunkCount: number;
}): AttachmentManifestV1 {
  const { seed, withThumbnail, chunkCount } = options;
  return {
    attachment_id: fill(seed, 16),
    ckbfs_root: buildOutPoint(seed + 1),
    chunk_outpoints: Array.from({ length: chunkCount }, (_, i) => buildOutPoint(seed + 2 + i)),
    encrypted_size: BigInt(4096 + seed),
    plaintext_size: BigInt(3800 + seed),
    mime_type: utf8("image/webp"),
    width: 1280,
    height: 960,
    thumbnail: withThumbnail ? fill(0x74, 128) : undefined,
    content_hash: fill(0xc1, 32),
    cipher_hash: fill(0xc2, 32),
    encryption_nonce: fill(0x0c, 12),
    encryption_algorithm: { family: 0x03, parameter: 1 },
    reclaim_group_id: fill(0x26, 16),
  };
}

// ── profile fixtures (spec §5) ──────────────────────────────────────────────

/** Every Option arm present. */
export function buildProfileFull(): CempProfileV1 {
  return {
    protocol_version: 1,
    sig_algorithm: { family: 0x01, parameter: 61 },
    kem_algorithm: { family: 0x02, parameter: 3 },
    ml_dsa_public_key: fill(0xd5, 1952),
    ml_kem_public_key: fill(0xae, 1184),
    lock_script_hash: fill(0x10, 32),
    supported_protocol_versions: [1],
    supported_attachments: 0x03,
    handle: utf8("alice"),
    icon_hash: fill(0x1c, 32),
    key_created_at: FIXED_UNIX_SECONDS,
    rotation_sequence: 1,
    previous_profile_id: fill(0x9e, 32),
    revoked: 0x00,
  };
}

/** Every Option arm absent. */
export function buildProfileMinimal(): CempProfileV1 {
  return {
    protocol_version: 1,
    sig_algorithm: { family: 0x01, parameter: 61 },
    kem_algorithm: { family: 0x02, parameter: 3 },
    ml_dsa_public_key: fill(0xd5, 1952),
    ml_kem_public_key: fill(0xae, 1184),
    lock_script_hash: fill(0x10, 32),
    supported_protocol_versions: [1],
    supported_attachments: 0x00,
    handle: undefined,
    icon_hash: undefined,
    key_created_at: FIXED_UNIX_SECONDS,
    rotation_sequence: 0,
    previous_profile_id: undefined,
    revoked: 0x00,
  };
}

/** Limit boundaries: 64-byte handle, 8 supported versions. */
export function buildProfileBoundaries(): CempProfileV1 {
  return {
    ...buildProfileMinimal(),
    handle: fill(0x68, 64),
    supported_protocol_versions: [1, 2, 3, 4, 5, 6, 7, 8],
  };
}

// ── envelope fixtures (spec §7) ─────────────────────────────────────────────

export function buildEnvelopeHeader(replyTo: boolean): CempEnvelopeHeaderV1 {
  return {
    protocol_version: 1,
    network: 0x01,
    content_type: CONTENT_TYPE.Text,
    message_id: fill(0x16, 16),
    conversation_id: fill(0xc0, 32),
    sender_profile_id: fill(0x5e, 32),
    created_at_client: FIXED_UNIX_SECONDS,
    reply_to_message_id: replyTo ? fill(0x17, 16) : undefined,
    expiry_hint: replyTo ? FIXED_UNIX_SECONDS_LATER : 0n,
  };
}

export function buildEnvelope(replyTo: boolean): CempEnvelopeV1 {
  return {
    header: buildEnvelopeHeader(replyTo),
    kem_ciphertext: fill(0x77, 1088),
    nonce: fill(0x12, 12),
    // Not a real ciphertext — fixtures pin serialization bytes only.
    encrypted_payload: fill(0xec, replyTo ? 96 : 64),
  };
}

// ── payload fixtures (spec §8) ──────────────────────────────────────────────

function payloadBase(): CempPayloadV1 {
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

/** Plain text message. */
export function buildPayloadText(): CempPayloadV1 {
  return {
    ...payloadBase(),
    text: utf8("hello cemp"),
    receipts: [buildReceiptEntry(0x51)],
    receipt_request: 0x01,
    padding: fill(0x99, 8),
  };
}

/** Limit boundary: text exactly 16,384 bytes, zero padding. */
export function buildPayloadTextMax(): CempPayloadV1 {
  return {
    ...payloadBase(),
    text: fill(0x61, 16_384),
  };
}

/**
 * Standalone receipt message (spec §9): no text. Limit boundaries:
 * 64 receipts, 255-byte padding.
 */
export function buildPayloadReceiptMax(): CempPayloadV1 {
  return {
    ...payloadBase(),
    body_type: CONTENT_TYPE.Receipt,
    receipts: buildReceipts(64),
    receipt_request: 0x03,
    padding: fill(0x77, 255),
  };
}

/** Both reply Option arms present (spec §7.3 response linkage). */
export function buildPayloadReply(): CempPayloadV1 {
  return {
    ...payloadBase(),
    text: utf8("got it"),
    reply_to_message_id: fill(0x17, 16),
    reply_to_outpoint: buildOutPoint(0x33),
  };
}

/** Attachment-manifest message (Phase 10). Boundary: 4 manifests. */
export function buildPayloadAttachmentManifestsMax(): CempPayloadV1 {
  return {
    ...payloadBase(),
    body_type: CONTENT_TYPE.AttachmentManifest,
    attachment_manifests: [
      buildAttachmentManifest({ seed: 0x40, withThumbnail: true, chunkCount: 2 }),
      buildAttachmentManifest({ seed: 0x50, withThumbnail: false, chunkCount: 0 }),
      buildAttachmentManifest({ seed: 0x60, withThumbnail: true, chunkCount: 1 }),
      buildAttachmentManifest({ seed: 0x70, withThumbnail: false, chunkCount: 3 }),
    ],
    padding: fill(0x88, 3),
  };
}

/** Smallest valid payload: absent text, empty vecs, zero padding. */
export function buildPayloadMinimal(): CempPayloadV1 {
  return {
    ...payloadBase(),
    body_type: CONTENT_TYPE.Receipt,
  };
}

// ── reclaim group fixtures (spec §10, local only) ───────────────────────────

export function buildReclaimGroup(outpointCount: number): ReclaimGroupV1 {
  return {
    reclaim_group_id: fill(0x26, 16),
    reason: 0x01,
    created_at: FIXED_UNIX_SECONDS,
    outpoints: Array.from({ length: outpointCount }, (_, i) => buildOutPoint(0x51 + i)),
  };
}

// ── fixture registry ────────────────────────────────────────────────────────

/**
 * One golden-vector case: a deterministic value plus its structure's strict
 * encode/decode pair. `encode`/`decode` are typed as taking/returning
 * `unknown` so the registry is homogeneous; each entry still delegates to the
 * fully-typed strict pair of its structure.
 */
export interface FixtureEntry {
  readonly name: string;
  readonly structure: string;
  readonly value: unknown;
  encode(value: unknown): Uint8Array;
  decode(data: BytesLike): unknown;
}

function defineFixture<T>(
  name: string,
  structure: string,
  value: T,
  codec: { encode: (value: T) => Uint8Array; decode: (data: BytesLike) => T },
): FixtureEntry {
  return { name, structure, value, encode: codec.encode, decode: codec.decode };
}

/** All deterministic fixtures, in golden-vector order. */
export const CODEC_FIXTURES: readonly FixtureEntry[] = [
  defineFixture("profile-full", "CempProfileV1", buildProfileFull(), {
    encode: encodeCempProfileV1,
    decode: decodeCempProfileV1,
  }),
  defineFixture("profile-minimal", "CempProfileV1", buildProfileMinimal(), {
    encode: encodeCempProfileV1,
    decode: decodeCempProfileV1,
  }),
  defineFixture("profile-boundaries", "CempProfileV1", buildProfileBoundaries(), {
    encode: encodeCempProfileV1,
    decode: decodeCempProfileV1,
  }),
  defineFixture("envelope-header-no-reply", "CempEnvelopeHeaderV1", buildEnvelopeHeader(false), {
    encode: encodeCempEnvelopeHeaderV1,
    decode: decodeCempEnvelopeHeaderV1,
  }),
  defineFixture("envelope-header-reply", "CempEnvelopeHeaderV1", buildEnvelopeHeader(true), {
    encode: encodeCempEnvelopeHeaderV1,
    decode: decodeCempEnvelopeHeaderV1,
  }),
  defineFixture("envelope-no-reply", "CempEnvelopeV1", buildEnvelope(false), {
    encode: encodeCempEnvelopeV1,
    decode: decodeCempEnvelopeV1,
  }),
  defineFixture("envelope-reply", "CempEnvelopeV1", buildEnvelope(true), {
    encode: encodeCempEnvelopeV1,
    decode: decodeCempEnvelopeV1,
  }),
  defineFixture("outpoint", "OutPointV1", buildOutPoint(0x2a), {
    encode: encodeOutPointV1,
    decode: decodeOutPointV1,
  }),
  defineFixture("receipt-entry", "ReceiptEntryV1", buildReceiptEntry(0x51, 0x01), {
    encode: encodeReceiptEntryV1,
    decode: decodeReceiptEntryV1,
  }),
  defineFixture(
    "attachment-manifest-no-thumbnail",
    "AttachmentManifestV1",
    buildAttachmentManifest({ seed: 0x40, withThumbnail: false, chunkCount: 2 }),
    { encode: encodeAttachmentManifestV1, decode: decodeAttachmentManifestV1 },
  ),
  defineFixture(
    "attachment-manifest-thumbnail",
    "AttachmentManifestV1",
    buildAttachmentManifest({ seed: 0x50, withThumbnail: true, chunkCount: 1 }),
    { encode: encodeAttachmentManifestV1, decode: decodeAttachmentManifestV1 },
  ),
  defineFixture("payload-text", "CempPayloadV1", buildPayloadText(), {
    encode: encodeCempPayloadV1,
    decode: decodeCempPayloadV1,
  }),
  defineFixture("payload-text-max", "CempPayloadV1", buildPayloadTextMax(), {
    encode: encodeCempPayloadV1,
    decode: decodeCempPayloadV1,
  }),
  defineFixture("payload-receipt-max", "CempPayloadV1", buildPayloadReceiptMax(), {
    encode: encodeCempPayloadV1,
    decode: decodeCempPayloadV1,
  }),
  defineFixture("payload-reply", "CempPayloadV1", buildPayloadReply(), {
    encode: encodeCempPayloadV1,
    decode: decodeCempPayloadV1,
  }),
  defineFixture(
    "payload-attachment-manifests-max",
    "CempPayloadV1",
    buildPayloadAttachmentManifestsMax(),
    { encode: encodeCempPayloadV1, decode: decodeCempPayloadV1 },
  ),
  defineFixture("payload-minimal", "CempPayloadV1", buildPayloadMinimal(), {
    encode: encodeCempPayloadV1,
    decode: decodeCempPayloadV1,
  }),
  defineFixture("reclaim-group", "ReclaimGroupV1", buildReclaimGroup(2), {
    encode: encodeReclaimGroupV1,
    decode: decodeReclaimGroupV1,
  }),
  defineFixture("reclaim-group-empty", "ReclaimGroupV1", buildReclaimGroup(0), {
    encode: encodeReclaimGroupV1,
    decode: decodeReclaimGroupV1,
  }),
];
