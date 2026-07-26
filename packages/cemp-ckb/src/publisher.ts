/**
 * Text publication pipeline (spec Phase 7 tasks 1–10).
 *
 * Drives one queued local message through the full §11 outgoing path:
 *
 *   encrypting → building_transaction → awaiting_signature → submitting →
 *   pending → committed → available_on_chain
 *
 * Invariants honored here:
 * - **Rule 6 (journal before broadcast):** the outgoing-transaction record
 *   AND the message's chain ref are written in the `submitting` state, BEFORE
 *   `sendTransaction`. A crash between journal and broadcast is recoverable:
 *   the next `publishText` call for the same `logical_message_id` finds the
 *   journaled tx and RESUMES monitoring instead of building a duplicate
 *   (task 10 — a retry may produce a new transaction hash, but never a
 *   duplicate logical message).
 * - **Rule 4:** the recipient profile is re-resolved and binding-checked on
 *   every send.
 * - **Rule 15:** failures surface as {@link PublicationError} with a
 *   chain-jargon-free `userMessage`.
 */

import { codec } from "@cemp/core";
import type { TransactionLike } from "@ckb-ccc/core";
import { assembleTextMessage } from "./assemble.js";
import { buildSendMessageTx, type CempMessageTypeRef } from "./builders.js";
import { CempCkbError, type CempClient } from "./client.js";
import {
  JournaledAbandonedError,
  resumeJournaledBroadcast,
  waitForTransactionCommit,
} from "./monitor.js";
import { checkResolvedProfileBinding, resolveLiveProfile } from "./profiles.js";
import { trackBroadcastSpend } from "./signing.js";
import type { MlDsaV2TxSigner } from "./signing.js";
import { cccTransactionToWire } from "./wire.js";

/* ── store boundary (implemented by @cemp/database repositories) ─────────── */

export interface OutgoingTxRecord {
  readonly txHash: string;
  readonly state: string;
  readonly txHex: string | null;
  readonly capacityShannon: string | null;
}

/** Narrow persistence boundary — cemp-database implements this (rule 14 style). */
export interface PublicationStore {
  transitionMessage(messageRowId: number, to: string): Promise<void>;
  /** Current §11 state of a message row (the resume path walks from here). */
  getMessageState(messageRowId: number): Promise<string | undefined>;
  setMessageChainRef(
    messageRowId: number,
    ref: { txHash: string; outpointIndex: number },
  ): Promise<void>;
  /** Persist the envelope's 16-byte message id (Phase 8 receipt matching). */
  setEnvelopeMessageId(messageRowId: number, envelopeMessageIdHex: string): Promise<void>;
  recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string;
    submittedAtMs?: number;
    /** Message-cell capacity (accounting, review E3). */
    capacityShannon?: string;
    /** The signed wire transaction as JSON (schema v6; stored BEFORE broadcast). */
    txHex?: string;
  }): Promise<void>;
  markOutgoingTxState(txHash: string, state: string, committedAtMs?: number): Promise<void>;
  /** Latest outgoing-tx record for a purpose string, for resume-after-crash. */
  findOutgoingTxByPurpose(purpose: string): Promise<OutgoingTxRecord | undefined>;
  /** Reserve message-cell capacity at commit time (review E3 accounting). */
  reserveCapacity(amountShannon: string): Promise<void>;
}

/* ── user-facing failure mapping (task 9, rule 15) ───────────────────────── */

export type PublicationErrorCode =
  | "profile-not-found"
  | "insufficient-capacity"
  | "rejected-by-node"
  | "network-unavailable"
  | "commit-timeout"
  | "internal";

export class PublicationError extends Error {
  readonly code: PublicationErrorCode;
  /** Chain-jargon-free, user-presentable failure text (rule 15). */
  readonly userMessage: string;
  /**
   * True when the failure happened AFTER broadcast (review C-2): the tx is
   * legitimately in flight and may still land, so the UI must NOT treat the
   * message as failed — the resume path picks it up on the next call.
   */
  readonly broadcast: boolean;

  constructor(
    code: PublicationErrorCode,
    userMessage: string,
    cause?: unknown,
    options: { broadcast?: boolean } = {},
  ) {
    super(`${code}: ${userMessage}`, cause === undefined ? undefined : { cause });
    this.name = "PublicationError";
    this.code = code;
    this.userMessage = userMessage;
    this.broadcast = options.broadcast ?? false;
  }
}

/** Classify a pipeline failure into a user-readable publication error. */
export function classifyPublishError(
  error: unknown,
  options: { broadcast?: boolean } = {},
): PublicationError {
  const broadcast = options.broadcast ?? false;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PublicationError) {
    return error;
  }
  if (message.includes("no live profile cell") || message.includes("failed validation")) {
    return new PublicationError(
      "profile-not-found",
      "This contact's profile could not be found. Ask them to check their profile is still active.",
      error,
      { broadcast },
    );
  }
  if (message.includes("capacity") || message.includes("Insufficient")) {
    return new PublicationError(
      "insufficient-capacity",
      "Not enough balance to cover this message. Top up your messaging capacity and try again.",
      error,
      { broadcast },
    );
  }
  if (message.includes("timed out")) {
    return new PublicationError(
      "commit-timeout",
      "Still waiting for network confirmation. The message is saved — check back shortly.",
      error,
      { broadcast },
    );
  }
  if (
    message.includes("fetch") ||
    message.includes("network") ||
    message.includes("ECONNREFUSED") ||
    message.includes("timed")
  ) {
    return new PublicationError(
      "network-unavailable",
      "Can't reach the network right now. The message is saved and can be retried.",
      error,
      { broadcast },
    );
  }
  if (message.includes("rejected")) {
    return new PublicationError(
      "rejected-by-node",
      "The network rejected this message. It has been saved — try again in a moment.",
      error,
      { broadcast },
    );
  }
  return new PublicationError(
    "internal",
    "Something went wrong while sending. The message is saved.",
    error,
    { broadcast },
  );
}

/* ── the pipeline ────────────────────────────────────────────────────────── */

export interface MessagePublisherDeps {
  readonly client: CempClient;
  readonly signer: MlDsaV2TxSigner;
  readonly messageType: CempMessageTypeRef;
  readonly store: PublicationStore;
  /** Own 32-byte profile id (outgoing envelopes name the sender). */
  readonly senderProfileId: Uint8Array;
  readonly senderDeviceId: Uint8Array;
}

export interface PublishTextInput {
  /** Local message row (already inserted as draft/queued by the composer). */
  readonly messageRowId: number;
  /** Idempotency key (spec Phase 7): retries must reuse this exact id. */
  readonly logicalMessageId: string;
  readonly text: string;
  readonly recipientProfileIdHex: string;
  readonly replyTo?: {
    readonly messageId: Uint8Array;
    readonly outPoint: { readonly txHash: string; readonly index: string | number };
  };
  readonly receipts?: readonly { readonly messageId: Uint8Array; readonly status: number }[];
  readonly receiptRequest?: number;
  /** Payload content type (default 0x01 text; 0x03 = attachment manifest). */
  readonly contentType?: 0x01 | 0x03;
  /** Attachment manifests for a 0x03 message (Phase 10; ≤ 4 per payload). */
  readonly attachmentManifests?: readonly codec.AttachmentManifestV1Encodable[];
  /**
   * Attachment-key coordination (spec §6). Supply ONLY for 0x03 attachment
   * messages, and ONLY fresh CSPRNG values per message (no reuse). Forwarded
   * verbatim to the envelope so the sealed key matches the chunk key.
   */
  readonly attachmentEnvelope?: { readonly kemMessage: Uint8Array; readonly nonce: Uint8Array };
  /** Commit deadline (default 180 s). */
  readonly timeoutMs?: number;
}

export interface PublishResult {
  readonly txHash: string;
  readonly outPoint: { txHash: string; index: number };
  /** True when the message reached `available_on_chain` (committed). */
  readonly committed: boolean;
  /** True when an existing journaled tx was adopted instead of rebuilding. */
  readonly resumed: boolean;
}

/**
 * The §11 outgoing path the publisher drives (review C-1). The resume path
 * walks the row along these steps — never skipping — so every transition is
 * a legal edge regardless of where a crash or UI retry left the row.
 */
const OUTGOING_PUBLISH_PATH = [
  "draft",
  "queued",
  "encrypting",
  "building_transaction",
  "awaiting_signature",
  "submitting",
  "pending",
  "committed",
  "available_on_chain",
] as const;
type PublishPathState = (typeof OUTGOING_PUBLISH_PATH)[number];

export class MessagePublisher {
  readonly #deps: MessagePublisherDeps;

  constructor(deps: MessagePublisherDeps) {
    this.#deps = deps;
  }

  /**
   * Publish (or resume publishing) one queued text message. Idempotent on
   * `logicalMessageId`: safe to call again after any crash or failure.
   */
  async publishText(input: PublishTextInput): Promise<PublishResult> {
    const { store } = this.#deps;
    const purpose = `message:${input.logicalMessageId}`;
    // Once the tx is broadcast, failures (e.g. commit timeout) must NOT mark
    // the message failed — it is legitimately pending and the resume path
    // below picks it up on the next call.
    let broadcast = false;
    try {
      // Resume: a journaled tx for this logical message already exists (crash
      // between journal and monitor, or an app restart mid-flight). Review E1:
      // rebroadcast from the journaled signed bytes when the network never saw
      // the tx; a tx the network never saw is NOT marked broadcast, so the
      // failure path below records it as a normal send failure.
      const existing = await store.findOutgoingTxByPurpose(purpose);
      let resumable = existing;
      if (resumable !== undefined) {
        try {
          const outcome = await resumeJournaledBroadcast(
            this.#deps.client,
            { txHash: resumable.txHash, txHex: resumable.txHex },
            { ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) },
          );
          if (outcome === "rebroadcast" && resumable.txHex !== null) {
            // F-1 one layer up: the rebroadcast spends the journaled inputs,
            // but the indexer keeps reporting them live until the tx commits
            // — mark the spend or the next build re-selects them and is
            // dropped as a double-spend. The journaled wire JSON is
            // structurally a TransactionLike (produced by cccTransactionToWire).
            await trackBroadcastSpend(
              this.#deps.signer,
              JSON.parse(resumable.txHex) as TransactionLike,
            );
          }
        } catch (error) {
          if (!(error instanceof JournaledAbandonedError)) {
            throw error;
          }
          // T17 finding F-1: the journaled tx can NEVER land (rejected — e.g.
          // built over an input its own chunk tx had just spent — or signed
          // bytes missing). Abandon it and fall through to a FRESH build,
          // mirroring the reclaim lifecycle's abandon+requeue (review E1/E2).
          // The logical id is unchanged, so the envelope message id every
          // receipt/reply references is stable; the new journal record becomes
          // the latest for this purpose. Without this the row wedged forever.
          await store.markOutgoingTxState(resumable.txHash, "abandoned");
          resumable = undefined;
        }
      }
      if (resumable !== undefined) {
        broadcast = true;
        // Review C-1: drive the row from its CURRENT state through the legal
        // §11 path to `pending` before #monitor's committed →
        // available_on_chain. A row requeued by the UI retry (failed →
        // queued) has no direct queued → committed edge and would wedge.
        await this.#walkToState(input.messageRowId, "pending");
        return await this.#monitor(
          input.messageRowId,
          resumable.txHash,
          true,
          input.timeoutMs,
          resumable.capacityShannon ?? undefined,
        );
      }

      await store.transitionMessage(input.messageRowId, "encrypting");
      const resolved = await resolveLiveProfile(this.#deps.client, input.recipientProfileIdHex);
      checkResolvedProfileBinding(resolved, input.recipientProfileIdHex);
      const recipientProfileId = codec.hexToBytes(
        input.recipientProfileIdHex.startsWith("0x")
          ? input.recipientProfileIdHex.slice(2)
          : input.recipientProfileIdHex,
      );
      const assembled = assembleTextMessage({
        text: input.text,
        senderProfileId: this.#deps.senderProfileId,
        recipientProfileId,
        recipientKemPublicKey: resolved.profile.ml_kem_public_key,
        senderDeviceId: this.#deps.senderDeviceId,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        ...(input.receipts === undefined ? {} : { receipts: input.receipts }),
        receiptRequest: input.receiptRequest ?? 1,
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        ...(input.attachmentManifests === undefined
          ? {}
          : { attachmentManifests: input.attachmentManifests }),
        ...(input.attachmentEnvelope === undefined
          ? {}
          : { attachmentEnvelope: input.attachmentEnvelope }),
      });

      await store.transitionMessage(input.messageRowId, "building_transaction");
      const built = await buildSendMessageTx({
        envelopeBytes: assembled.envelopeBytes,
        routeTag: assembled.routeTag,
        conversationTag: assembled.conversationTag,
        messageNonce: assembled.messageNonce,
        sender: this.#deps.signer,
        cempMessageType: this.#deps.messageType,
      });

      await store.transitionMessage(input.messageRowId, "awaiting_signature");
      const signed = await this.#deps.signer.signTransaction(built.tx);
      const txHash = signed.hash();

      await store.transitionMessage(input.messageRowId, "submitting");
      // RULE 6: journal (tx record + chain ref) BEFORE broadcast. The signed
      // wire bytes are journaled for rebroadcast resume (review E1), and the
      // message cell's capacity for the accounting path (review E3).
      const messageCellCapacity = built.tx.outputs[0]?.capacity ?? 0n;
      const wire = cccTransactionToWire(signed);
      await store.recordOutgoingTx({
        txHash,
        purpose,
        state: "submitted",
        feeShannon: built.estimatedFee.toString(),
        capacityShannon: messageCellCapacity.toString(),
        txHex: JSON.stringify(wire),
        submittedAtMs: Date.now(),
      });
      await store.setMessageChainRef(input.messageRowId, { txHash, outpointIndex: 0 });
      // Receipts and reply_to reference the ENVELOPE message id (Phase 8).
      await store.setEnvelopeMessageId(input.messageRowId, codec.bytesToHex(assembled.messageId));

      const accepted = await this.#deps.client.sendTransaction(wire);
      if (accepted !== txHash) {
        throw new CempCkbError(
          "publisher",
          "node returned a tx hash different from the signed transaction",
        );
      }
      broadcast = true;
      // The inputs are spent now, but the indexer keeps reporting them live
      // until this tx commits — tell the coin selector, or the next message
      // re-selects them and is dropped as a double-spend.
      await trackBroadcastSpend(this.#deps.signer, signed);

      await store.transitionMessage(input.messageRowId, "pending");
      return await this.#monitor(
        input.messageRowId,
        txHash,
        false,
        input.timeoutMs,
        messageCellCapacity.toString(),
      );
    } catch (error) {
      const publicationError = classifyPublishError(error, { broadcast });
      if (!broadcast) {
        // Pre-broadcast failure: the message never left the device — record
        // the failure on the row (the journal still holds the truth).
        try {
          await store.transitionMessage(input.messageRowId, "failed");
        } catch {
          // The row may be mid-transition; the journal still holds the truth.
        }
      }
      throw publicationError;
    }
  }

  /** Drive a journaled tx to commit and land the message in available_on_chain. */
  async #monitor(
    messageRowId: number,
    txHash: string,
    resumed: boolean,
    timeoutMs?: number,
    reserveAmountShannon?: string,
  ): Promise<PublishResult> {
    const { store } = this.#deps;
    await waitForTransactionCommit(this.#deps.client, txHash, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    await store.markOutgoingTxState(txHash, "committed", Date.now());
    await store.setMessageChainRef(messageRowId, { txHash, outpointIndex: 0 });
    await this.#walkToState(messageRowId, "available_on_chain");
    // Review E3: reserve the committed message cell's capacity in the ledger
    // (the ack path later moves it to reclaimable; reclaim releases it).
    if (reserveAmountShannon !== undefined && reserveAmountShannon !== "0") {
      await store.reserveCapacity(reserveAmountShannon);
    }
    return { txHash, outPoint: { txHash, index: 0 }, committed: true, resumed };
  }

  /**
   * Drive a message row stepwise along the legal §11 outgoing path to
   * `target` (review C-1). A state already AT or PAST the target is an
   * idempotent no-op; a state OFF the path (e.g. `failed` after the UI retry
   * edge failed → queued was taken... the row must already be `queued` then)
   * starts the walk at `queued`, the only legal exit from `failed`.
   */
  async #walkToState(messageRowId: number, target: string): Promise<void> {
    const { store } = this.#deps;
    const current = await store.getMessageState(messageRowId);
    const fromIndex =
      current === undefined ? -1 : OUTGOING_PUBLISH_PATH.indexOf(current as PublishPathState);
    const toIndex = OUTGOING_PUBLISH_PATH.indexOf(target as PublishPathState);
    if (toIndex === -1 || fromIndex >= toIndex) {
      return;
    }
    // `draft` sits at index 0; any state NOT on the path (undefined row,
    // `failed`) starts at `queued` — failed → queued is the retry edge.
    const start = fromIndex === -1 ? 1 : fromIndex + 1;
    for (let i = start; i <= toIndex; i++) {
      await store.transitionMessage(messageRowId, OUTGOING_PUBLISH_PATH[i]!);
    }
  }
}
