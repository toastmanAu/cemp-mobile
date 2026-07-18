/**
 * Message assembly (spec §6–§8): text payload → envelope header → encrypted
 * envelope, plus the routing-epoch helper. This is THE assembly path — the
 * reference client re-exports it; app publication goes through the publisher
 * (publisher.ts), which wraps it.
 */

import { codec, deriveConversationId, deriveRouteTag } from "@cemp/core";
import { encryptEnvelope, randomBytes, randomPadding } from "@cemp/crypto";
import { CempCkbError } from "./client.js";

/** Routing epoch length in seconds: 30 days (protocol spec §2). */
export const ROUTING_EPOCH_SECONDS = 2_592_000;

/** Current routing epoch (wall-clock, truncated to the epoch window). */
export function currentRoutingEpoch(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000 / ROUTING_EPOCH_SECONDS));
}

export interface AssembleTextMessageParams {
  readonly text: string;
  readonly senderProfileId: Uint8Array;
  readonly recipientProfileId: Uint8Array;
  readonly recipientKemPublicKey: Uint8Array;
  readonly senderDeviceId: Uint8Array;
  readonly replyTo?: {
    readonly messageId: Uint8Array;
    readonly outPoint: { readonly txHash: string; readonly index: string | number };
  };
  readonly receipts?: readonly { readonly messageId: Uint8Array; readonly status: number }[];
  readonly receiptRequest?: number;
  /** Attachment manifests for this message (Phase 10; ≤ 4 per payload). */
  readonly attachmentManifests?: readonly codec.AttachmentManifestV1Encodable[];
  /**
   * Payload content type (default 0x01 text). 0x03 = attachment_manifest
   * (Phase 10): `text` becomes an optional caption.
   */
  readonly contentType?: 0x01 | 0x03;
  /** Deterministic message id (tests / idempotent re-assembly); random otherwise. */
  readonly messageId?: Uint8Array;
  readonly nowMs?: number;
}

export interface AssembledMessage {
  readonly messageId: Uint8Array;
  readonly conversationId: Uint8Array;
  readonly routeTag: Uint8Array;
  readonly conversationTag: Uint8Array;
  readonly messageNonce: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  /** The envelope-derived attachment key (Phase 10; SECRET — caller wipes). */
  readonly attachmentKey: Uint8Array;
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/** Build + encrypt a v1 text message (spec §6–§8): payload → header → envelope. */
export function assembleTextMessage(params: AssembleTextMessageParams): AssembledMessage {
  const messageId = params.messageId ?? randomBytes(16);
  const conversationId = deriveConversationId(params.senderProfileId, params.recipientProfileId);
  const routeTag = deriveRouteTag(params.recipientProfileId, currentRoutingEpoch(params.nowMs));
  const conversationTag = conversationId.subarray(0, 16);
  const messageNonce = randomBytes(16);
  const now = BigInt(Math.floor((params.nowMs ?? Date.now()) / 1000));
  const contentType = params.contentType ?? 0x01;

  const payload = codec.encodeCempPayloadV1({
    message_id: messageId,
    body_type: contentType,
    recipient_profile_id: params.recipientProfileId,
    // Text is required for 0x01, an optional caption for 0x03 (spec §7/§8).
    text:
      contentType === 0x03 && params.text.length === 0
        ? undefined
        : new TextEncoder().encode(params.text),
    attachment_manifests: [...(params.attachmentManifests ?? [])],
    reply_to_message_id: params.replyTo?.messageId,
    reply_to_outpoint:
      params.replyTo === undefined
        ? undefined
        : {
            tx_hash: codec.hexToBytes(strip0x(params.replyTo.outPoint.txHash)),
            index: Number(BigInt(params.replyTo.outPoint.index)),
          },
    receipts: (params.receipts ?? []).map((receipt) => ({
      message_id: receipt.messageId,
      status: receipt.status,
    })),
    receipt_request: params.receiptRequest ?? 0,
    client_timestamp: now,
    sender_device_id: params.senderDeviceId,
    padding: randomPadding(),
  });
  const payloadCheck = codec.validatePayload(payload);
  if (!payloadCheck.ok) {
    throw new CempCkbError(
      "assembleTextMessage",
      `assembled payload failed validation: ${payloadCheck.reason}`,
    );
  }

  const header: codec.CempEnvelopeHeaderV1Encodable = {
    protocol_version: 1,
    network: 0x01, // ckb_testnet
    content_type: contentType,
    message_id: messageId,
    conversation_id: conversationId,
    sender_profile_id: params.senderProfileId,
    created_at_client: now,
    reply_to_message_id: params.replyTo?.messageId,
    expiry_hint: 0n,
  };
  const { envelopeBytes, attachmentKey } = encryptEnvelope({
    payload,
    recipientKemPublicKey: params.recipientKemPublicKey,
    header,
  });
  return {
    messageId,
    conversationId,
    routeTag,
    conversationTag,
    messageNonce,
    envelopeBytes,
    attachmentKey,
  };
}
