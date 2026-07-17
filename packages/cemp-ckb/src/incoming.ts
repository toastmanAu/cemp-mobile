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

/** A decrypted, fully validated incoming text message. */
export interface IncomingTextMessage {
  readonly messageId: Uint8Array;
  readonly conversationId: Uint8Array;
  readonly senderProfileId: Uint8Array;
  readonly text: string;
  readonly replyToMessageId: Uint8Array | null;
  readonly replyToOutpoint: { txHash: string; index: number } | null;
  readonly receipts: readonly { messageId: Uint8Array; status: number }[];
  readonly clientTimestamp: bigint;
  readonly senderDeviceId: Uint8Array;
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
  const { header, payloadBytes } = decryptEnvelope({
    envelopeBytes: input.cellData,
    recipientKemSecretKey: input.ownKemSecretKey,
    ownProfileId: input.ownProfileId,
  });
  const payloadCheck = codec.validatePayload(payloadBytes);
  if (!payloadCheck.ok) {
    throw new CempCkbError(
      "processIncomingText",
      `payload failed validation: ${payloadCheck.reason}`,
    );
  }
  const payload = codec.decodeCempPayloadV1(payloadBytes);
  const consistency = codec.validateSemanticConsistency(header, payload, input.ownProfileId);
  if (!consistency.ok) {
    throw new CempCkbError("processIncomingText", `header/payload mismatch: ${consistency.reason}`);
  }
  if (payload.body_type !== 0x01 || payload.text === undefined) {
    throw new CempCkbError("processIncomingText", "payload is not a text message");
  }
  return {
    messageId: payload.message_id,
    conversationId: header.conversation_id,
    senderProfileId: header.sender_profile_id,
    text: new TextDecoder().decode(payload.text),
    replyToMessageId: payload.reply_to_message_id ?? null,
    replyToOutpoint:
      payload.reply_to_outpoint === null || payload.reply_to_outpoint === undefined
        ? null
        : {
            txHash: codec.bytesToHex(payload.reply_to_outpoint.tx_hash),
            index: Number(payload.reply_to_outpoint.index),
          },
    receipts: payload.receipts.map((receipt) => ({
      messageId: receipt.message_id,
      status: receipt.status,
    })),
    clientTimestamp: payload.client_timestamp,
    senderDeviceId: payload.sender_device_id,
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
