/**
 * Message assembly (spec §6–§8): text payload → envelope header → encrypted
 * envelope, plus the routing-epoch helper. This is THE assembly path — the
 * reference client re-exports it; app publication goes through the publisher
 * (publisher.ts), which wraps it.
 */

import { codec, deriveConversationId, deriveRouteTag } from "@cemp/core";
import { encryptEnvelope, randomBytes, randomPadding, sealEnvelopeV3 } from "@cemp/crypto";
import { CempCkbError } from "./client.js";

/** Routing epoch length in seconds: 30 days (protocol spec §2). */
export const ROUTING_EPOCH_SECONDS = 2_592_000;

/** Current routing epoch (wall-clock, truncated to the epoch window). */
export function currentRoutingEpoch(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000 / ROUTING_EPOCH_SECONDS));
}

/**
 * One outgoing receipt (ADR 0006). The caller supplies the proof it computed
 * with `computeReceiptProof(receiptKey, messageId, status)` from the receipt
 * key it stored for the ORIGINAL incoming message; assembly never sees a
 * receipt key, and an entry without a 32-byte proof is refused. There is no
 * unproven (v1) receipt send path.
 */
export interface ProvenReceipt {
  readonly messageId: Uint8Array;
  readonly status: number;
  readonly proof: Uint8Array;
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
  readonly receipts?: readonly ProvenReceipt[];
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
  /**
   * Attachment-key coordination seam (spec §6): fix the envelope's KEM
   * encapsulation + nonce so the sender can pre-derive the attachmentKey for
   * chunk encryption. MUST be fresh CSPRNG per message (no reuse). Supplied
   * ONLY by the image-send orchestration.
   */
  readonly attachmentEnvelope?: { readonly kemMessage: Uint8Array; readonly nonce: Uint8Array };
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
  /**
   * The envelope-derived receipt key (ADR 0006; SECRET — caller stores it on
   * the outgoing row before broadcast, then wipes this copy).
   */
  readonly receiptKey: Uint8Array;
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/** The `CempPayloadV2` of an outgoing message (shared by v2 and v3 assembly). */
function buildPayloadV2(
  params: AssembleTextMessageParams,
  messageId: Uint8Array,
  contentType: number,
  now: bigint,
): codec.CempPayloadV2 {
  for (const receipt of params.receipts ?? []) {
    if (receipt.proof.length !== 32) {
      throw new CempCkbError(
        "assembleTextMessage",
        `receipt proof is ${receipt.proof.length} bytes, expected 32 (ADR 0006)`,
      );
    }
  }
  const payload: codec.CempPayloadV2 = {
    message_id: messageId,
    body_type: contentType,
    recipient_profile_id: params.recipientProfileId,
    // Text is required for 0x01, an optional caption for 0x03 (spec §7/§8).
    text:
      contentType === 0x03 && params.text.length === 0
        ? undefined
        : new TextEncoder().encode(params.text),
    attachment_manifests: [...(params.attachmentManifests ?? [])].map((m) =>
      codec.decodeAttachmentManifestV1(codec.encodeAttachmentManifestV1(m)),
    ),
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
      proof: receipt.proof,
    })),
    receipt_request: params.receiptRequest ?? 0,
    client_timestamp: now,
    sender_device_id: params.senderDeviceId,
    padding: randomPadding(),
  };
  const payloadCheck = codec.validatePayloadV2(codec.encodeCempPayloadV2(payload));
  if (!payloadCheck.ok) {
    throw new CempCkbError(
      "assembleTextMessage",
      `assembled payload failed validation: ${payloadCheck.reason}`,
    );
  }
  return payload;
}

/**
 * Build + encrypt a protocol-version-2 message (spec §6–§8, ADR 0006):
 * payload → header → envelope. LEGACY: no production send path uses it
 * after ADR 0007; it builds the unsigned v2 cells that receivers must label
 * "Unverified (legacy)", and the Phase A forgeries.
 */
export function assembleTextMessage(params: AssembleTextMessageParams): AssembledMessage {
  const messageId = params.messageId ?? randomBytes(16);
  const conversationId = deriveConversationId(params.senderProfileId, params.recipientProfileId);
  const routeTag = deriveRouteTag(params.recipientProfileId, currentRoutingEpoch(params.nowMs));
  const conversationTag = conversationId.subarray(0, 16);
  const messageNonce = randomBytes(16);
  const now = BigInt(Math.floor((params.nowMs ?? Date.now()) / 1000));
  const contentType = params.contentType ?? 0x01;

  const payload = codec.encodeCempPayloadV2(buildPayloadV2(params, messageId, contentType, now));
  const header: codec.CempEnvelopeHeaderV1Encodable = {
    // The legacy (v2) assembler: kept for interoperability tests and vectors.
    // Production sends are v3 (assembleTextMessageV3, ADR 0007 §7).
    protocol_version: 2,
    network: 0x01, // ckb_testnet
    content_type: contentType,
    message_id: messageId,
    conversation_id: conversationId,
    sender_profile_id: params.senderProfileId,
    created_at_client: now,
    reply_to_message_id: params.replyTo?.messageId,
    expiry_hint: 0n,
  };
  const { envelopeBytes, attachmentKey, receiptKey } = encryptEnvelope({
    payload,
    recipientKemPublicKey: params.recipientKemPublicKey,
    header,
    ...(params.attachmentEnvelope === undefined
      ? {}
      : {
          kemMessage: params.attachmentEnvelope.kemMessage,
          nonce: params.attachmentEnvelope.nonce,
        }),
  });
  return {
    messageId,
    conversationId,
    routeTag,
    conversationTag,
    messageNonce,
    envelopeBytes,
    attachmentKey,
    receiptKey,
  };
}

export interface AssembleTextMessageV3Params extends Omit<
  AssembleTextMessageParams,
  "senderProfileId"
> {
  /** The ACTIVE local profile id; the signer below must be its key. */
  readonly senderProfileId: Uint8Array;
  /** The active profile's ML-DSA-65 secret key (never a caller-chosen identity). */
  readonly signerSecretKey: Uint8Array;
  /** The active profile's published ML-DSA-65 public key (self-verify). */
  readonly signerPublicKey: Uint8Array;
  /** Deterministic signing for tests/vectors only (32 zero bytes). */
  readonly signingEntropy?: Uint8Array;
}

/**
 * Build, sign and encrypt a protocol-version-3 message (ADR 0007 §7): the
 * payload layout is unchanged (`CempPayloadV2`, proven receipts); the clear
 * header keeps only version, network and expiry; the sender id, conversation
 * id, content type and timestamp move inside the signed ciphertext.
 */
export function assembleTextMessageV3(params: AssembleTextMessageV3Params): AssembledMessage {
  const messageId = params.messageId ?? randomBytes(16);
  const conversationId = deriveConversationId(params.senderProfileId, params.recipientProfileId);
  const routeTag = deriveRouteTag(params.recipientProfileId, currentRoutingEpoch(params.nowMs));
  const conversationTag = conversationId.subarray(0, 16);
  const messageNonce = randomBytes(16);
  const now = BigInt(Math.floor((params.nowMs ?? Date.now()) / 1000));
  const contentType = params.contentType ?? 0x01;
  const payload = buildPayloadV2(params, messageId, contentType, now);
  const sealed = sealEnvelopeV3({
    header: { protocol_version: 3, network: 0x01, expiry_hint: 0n },
    senderProfileId: params.senderProfileId,
    contentType,
    createdAtClient: now,
    payload,
    recipientKemPublicKey: params.recipientKemPublicKey,
    signerSecretKey: params.signerSecretKey,
    signerPublicKey: params.signerPublicKey,
    ...(params.attachmentEnvelope === undefined
      ? {}
      : {
          kemMessage: params.attachmentEnvelope.kemMessage,
          nonce: params.attachmentEnvelope.nonce,
        }),
    ...(params.signingEntropy === undefined ? {} : { extraEntropy: params.signingEntropy }),
  });
  return {
    messageId,
    conversationId,
    routeTag,
    conversationTag,
    messageNonce,
    envelopeBytes: sealed.envelopeBytes,
    attachmentKey: sealed.attachmentKey,
    receiptKey: sealed.receiptKey,
  };
}
