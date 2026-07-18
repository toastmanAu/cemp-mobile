/**
 * Decoders for the protocol inspector: structural views of CEMP objects.
 * Every decoder is total — it returns a structured view or throws a
 * structured reason (never partial output, never a stack of guesses).
 * Decrypted content is handled ONLY via the explicit key path in payload.ts
 * (rule 2-adjacent: a debug tool is not an exemption).
 */

import { codec } from "@cemp/core";
import { TYPE_ID_CODE_HASH } from "@cemp/ckb";
import type { Cell } from "@cemp/ckb";

export interface MessageTypeArgsView {
  kind: "message-cell";
  version: number;
  routeTag: string;
  conversationTag: string;
  messageNonce: string;
  reservedAllZero: boolean;
}

export interface ProfileCellView {
  kind: "profile-cell";
  profileId: string;
}

export interface DataCellView {
  kind: "data-cell" | "unknown-cell";
}

export type CellKindView = MessageTypeArgsView | ProfileCellView | DataCellView;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (bare.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(bare)) {
    throw new Error(`expected even-length hex, got ${bare.length} chars`);
  }
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const TYPE_ARGS_BYTES = 81;

/**
 * Classify a cell by its type script: CEMP message cell (81-byte args), Type
 * ID profile cell, or plain data cell. Returns null for anything with no
 * type script or no recognisable args.
 */
export function classifyCell(cell: Cell): CellKindView {
  const type = cell.output.type;
  if (type === null) {
    return { kind: "data-cell" };
  }
  const args = hexToBytes(type.args);
  if (type.codeHash.toLowerCase() === TYPE_ID_CODE_HASH.toLowerCase() && args.length === 32) {
    return { kind: "profile-cell", profileId: `0x${bytesToHex(args)}` };
  }
  if (args.length === TYPE_ARGS_BYTES && args[0] === 1) {
    return {
      kind: "message-cell",
      version: args[0]!,
      routeTag: `0x${bytesToHex(args.slice(1, 33))}`,
      conversationTag: `0x${bytesToHex(args.slice(33, 49))}`,
      messageNonce: `0x${bytesToHex(args.slice(49, 65))}`,
      reservedAllZero: args.slice(65, 81).every((b) => b === 0),
    };
  }
  return { kind: "unknown-cell" };
}

/** Structural view of a serialized CempEnvelopeV1 (no decryption). */
export interface EnvelopeView {
  protocolVersion: number;
  network: number;
  contentType: number;
  messageId: string;
  conversationId: string;
  senderProfileId: string;
  createdAtClient: string;
  replyToMessageId: string | null;
  expiryHint: string;
  kemCiphertextBytes: number;
  nonceBytes: number;
  encryptedPayloadBytes: number;
  totalBytes: number;
}

/** Decode + validate an envelope's structure. Throws a plain reason. */
export function decodeEnvelope(bytes: Uint8Array): EnvelopeView {
  const validation = codec.validateEnvelope(bytes);
  if (!validation.ok) {
    throw new Error(`envelope rejected: ${validation.reason}`);
  }
  const envelope = codec.decodeCempEnvelopeV1(bytes);
  return {
    protocolVersion: envelope.header.protocol_version,
    network: envelope.header.network,
    contentType: envelope.header.content_type,
    messageId: `0x${bytesToHex(envelope.header.message_id)}`,
    conversationId: `0x${bytesToHex(envelope.header.conversation_id)}`,
    senderProfileId: `0x${bytesToHex(envelope.header.sender_profile_id)}`,
    createdAtClient: envelope.header.created_at_client.toString(),
    replyToMessageId:
      envelope.header.reply_to_message_id === undefined
        ? null
        : `0x${bytesToHex(envelope.header.reply_to_message_id)}`,
    expiryHint: envelope.header.expiry_hint.toString(),
    kemCiphertextBytes: envelope.kem_ciphertext.length,
    nonceBytes: envelope.nonce.length,
    encryptedPayloadBytes: envelope.encrypted_payload.length,
    totalBytes: bytes.length,
  };
}

/** Structural view of a CempProfileV1 cell data payload. */
export interface ProfileView {
  protocolVersion: number;
  sigAlgorithm: string;
  kemAlgorithm: string;
  mlDsaPublicKeyPrefix: string;
  mlKemPublicKeyPrefix: string;
  lockScriptHash: string;
  supportedProtocolVersions: readonly number[];
  supportedAttachments: number;
  handle: string | null;
  keyCreatedAt: string;
  rotationSequence: number;
  previousProfileId: string | null;
  revoked: boolean;
}

export function decodeProfile(bytes: Uint8Array): ProfileView {
  const validation = codec.validateProfile(bytes);
  if (!validation.ok) {
    throw new Error(`profile rejected: ${validation.reason}`);
  }
  const profile = codec.decodeCempProfileV1(bytes);
  return {
    protocolVersion: profile.protocol_version,
    sigAlgorithm: `family ${profile.sig_algorithm.family} param ${profile.sig_algorithm.parameter}`,
    kemAlgorithm: `family ${profile.kem_algorithm.family} param ${profile.kem_algorithm.parameter}`,
    mlDsaPublicKeyPrefix: `0x${bytesToHex(profile.ml_dsa_public_key.slice(0, 16))}…`,
    mlKemPublicKeyPrefix: `0x${bytesToHex(profile.ml_kem_public_key.slice(0, 16))}…`,
    lockScriptHash: `0x${bytesToHex(profile.lock_script_hash)}`,
    supportedProtocolVersions: profile.supported_protocol_versions,
    supportedAttachments: profile.supported_attachments,
    handle: profile.handle === undefined ? null : new TextDecoder().decode(profile.handle),
    keyCreatedAt: profile.key_created_at.toString(),
    rotationSequence: Number(profile.rotation_sequence),
    previousProfileId:
      profile.previous_profile_id === undefined
        ? null
        : `0x${bytesToHex(profile.previous_profile_id)}`,
    revoked: profile.revoked !== 0,
  };
}
