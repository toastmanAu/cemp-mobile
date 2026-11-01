/**
 * Incoming message processing (spec Phase 7 tasks 3–4 + exit criterion
 * "duplicate indexing does not create duplicate chat messages").
 *
 * Pure processing, no chain or storage access (rule 14): the caller (sync
 * worker, reference client) feeds discovered cell data in and persists the
 * result. Persistence dedups on {@link incomingLogicalMessageId} — the
 * envelope's 16-byte message id is the natural idempotency key, so an
 * indexer returning the same cell twice (or two indexers) collapses to one
 * chat row via the messages table's UNIQUE logical_message_id.
 *
 * The full spec §12 pipeline runs here: strict envelope validation (inside
 * `decryptEnvelope`), payload validation, and header↔payload semantic
 * consistency — malformed or hostile cells throw, they never reach storage.
 */

import { codec } from "@cemp/core";
import { decryptEnvelope } from "@cemp/crypto";
import { CempCkbError } from "./client.js";

/** Parsed 81-byte message-cell type args (spec §6). */
export interface MessageTypeArgs {
  readonly routeTag: Uint8Array;
  readonly conversationTag: Uint8Array;
  readonly messageNonce: Uint8Array;
}

const TYPE_ARGS_BYTES = 81;

/**
 * Parse and validate message-cell type args: fixed 81-byte layout, version
 * byte 1, reserved suffix all zero (spec §6). Anything else is not a v1
 * CEMP message cell.
 */
export function parseMessageTypeArgs(args: Uint8Array): MessageTypeArgs {
  if (args.length !== TYPE_ARGS_BYTES) {
    throw new CempCkbError(
      "parseMessageTypeArgs",
      `type args are ${args.length} bytes, expected 81`,
    );
  }
  if (args[0] !== 1) {
    throw new CempCkbError("parseMessageTypeArgs", `unsupported version byte ${String(args[0])}`);
  }
  const reserved = args.subarray(65, 81);
  if (reserved.some((b) => b !== 0)) {
    throw new CempCkbError(
      "parseMessageTypeArgs",
      "reserved bytes are nonzero (not a v1 message cell)",
    );
  }
  return {
    routeTag: args.slice(1, 33),
    conversationTag: args.slice(33, 49),
    messageNonce: args.slice(49, 65),
  };
}

/**
 * One receipt carried by an incoming payload. `proof` is the ADR 0006 proof
 * of decryption from a version-2 payload, or `null` for a version-1 receipt,
 * which is UNPROVEN and must never change state or capacity.
 */
export interface IncomingReceipt {
  readonly messageId: Uint8Array;
  readonly status: number;
  readonly proof: Uint8Array | null;
}

/** A decrypted, fully validated incoming message (text and/or attachments). */
export interface IncomingTextMessage {
  /** Envelope header protocol_version: 1 (legacy) or 2 (ADR 0006). */
  readonly protocolVersion: 1 | 2;
  readonly contentType: number;
  readonly messageId: Uint8Array;
  readonly conversationId: Uint8Array;
  readonly senderProfileId: Uint8Array;
  /** Text body (empty for pure attachment messages, content_type 0x03). */
  readonly text: string;
  /** Attachment manifests carried by this message (Phase 10). */
  readonly attachmentManifests: readonly codec.AttachmentManifestV1[];
  readonly replyToMessageId: Uint8Array | null;
  readonly replyToOutpoint: { txHash: string; index: number } | null;
  readonly receipts: readonly IncomingReceipt[];
  readonly clientTimestamp: bigint;
  readonly senderDeviceId: Uint8Array;
  /**
   * The envelope-derived attachment key (Phase 10; SECRET — caller wipes
   * after downloading attachments). Byte-identical to the sender's.
   */
  readonly attachmentKey: Uint8Array;
  /**
   * The envelope-derived receipt key (ADR 0006; SECRET — the caller stores it
   * on the incoming row, then wipes this copy). Byte-identical to the
   * sender's. `null` for a version-1 envelope: its sender is a pre-ADR-0006
   * build that cannot verify a proof, so no proven receipt is ever owed.
   */
  readonly receiptKey: Uint8Array | null;
}

export interface ProcessIncomingTextInput {
  /** Message-cell data (the serialized CempEnvelopeV1). */
  readonly cellData: Uint8Array;
  /** Own ML-KEM-768 secret key (2400 bytes). */
  readonly ownKemSecretKey: Uint8Array;
  /** Own 32-byte profile id (bound into the message key, spec §3). */
  readonly ownProfileId: Uint8Array;
}

/**
 * Decrypt + validate one discovered message cell. Throws {@link CempCkbError}
 * on any validation/decryption failure — the caller records the cell as
 * `invalid` (§11) and moves on; one bad cell must never stall discovery.
 */
export function processIncomingText(input: ProcessIncomingTextInput): IncomingTextMessage {
  const { header, payloadBytes, attachmentKey, receiptKey } = decryptEnvelope({
    envelopeBytes: input.cellData,
    recipientKemSecretKey: input.ownKemSecretKey,
    ownProfileId: input.ownProfileId,
  });
  try {
    return buildIncoming(header, payloadBytes, input.ownProfileId, attachmentKey, receiptKey);
  } catch (error) {
    // Nothing is returned on failure, so nobody else will wipe the keys.
    attachmentKey.fill(0);
    receiptKey.fill(0);
    throw error;
  }
}

function buildIncoming(
  header: codec.CempEnvelopeHeaderV1,
  payloadBytes: Uint8Array,
  ownProfileId: Uint8Array,
  attachmentKey: Uint8Array,
  receiptKey: Uint8Array,
): IncomingTextMessage {
  // ADR 0006: the header's protocol_version selects the payload layout.
  // Explicit dispatch — a payload that does not match is rejected, never
  // re-tried as the other version.
  const payloadCheck = codec.validatePayloadForVersion(header.protocol_version, payloadBytes);
  if (!payloadCheck.ok) {
    throw new CempCkbError(
      "processIncomingText",
      `payload failed validation: ${payloadCheck.reason}`,
    );
  }
  const decoded = codec.decodeCempPayload(header.protocol_version, payloadBytes);
  const payload = decoded.payload;
  const consistency = codec.validateSemanticConsistency(header, payload, ownProfileId);
  if (!consistency.ok) {
    throw new CempCkbError("processIncomingText", `header/payload mismatch: ${consistency.reason}`);
  }
  // Text (0x01) and attachment-manifest (0x03) payloads are processed here;
  // receipt (0x02) and unknown types are not (spec §8).
  if (payload.body_type !== 0x01 && payload.body_type !== 0x03) {
    throw new CempCkbError(
      "processIncomingText",
      `unsupported payload body_type ${String(payload.body_type)}`,
    );
  }
  const receipts: IncomingReceipt[] =
    decoded.version === 2
      ? decoded.payload.receipts.map((receipt) => ({
          messageId: receipt.message_id,
          status: receipt.status,
          proof: receipt.proof,
        }))
      : decoded.payload.receipts.map((receipt) => ({
          messageId: receipt.message_id,
          status: receipt.status,
          proof: null,
        }));
  if (decoded.version === 1) {
    receiptKey.fill(0);
  }
  return {
    protocolVersion: decoded.version,
    contentType: payload.body_type,
    messageId: payload.message_id,
    conversationId: header.conversation_id,
    senderProfileId: header.sender_profile_id,
    text: payload.text === undefined ? "" : new TextDecoder().decode(payload.text),
    attachmentManifests: payload.attachment_manifests,
    replyToMessageId: payload.reply_to_message_id ?? null,
    replyToOutpoint:
      payload.reply_to_outpoint === null || payload.reply_to_outpoint === undefined
        ? null
        : {
            txHash: codec.bytesToHex(payload.reply_to_outpoint.tx_hash),
            index: Number(payload.reply_to_outpoint.index),
          },
    receipts,
    clientTimestamp: payload.client_timestamp,
    senderDeviceId: payload.sender_device_id,
    attachmentKey,
    receiptKey: decoded.version === 2 ? receiptKey : null,
  };
}

/**
 * The idempotency key for an incoming message: `incoming:<message_id hex>`.
 * Persisting with this logical id makes duplicate indexing a no-op (UNIQUE
 * constraint → the existing row is returned).
 */
export function incomingLogicalMessageId(messageId: Uint8Array): string {
  return `incoming:${codec.bytesToHex(messageId)}`;
}
