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
import { assembleTextMessage } from "./assemble.js";
import { buildSendMessageTx, type CempMessageTypeRef } from "./builders.js";
import { CempCkbError, type CempClient } from "./client.js";
import { waitForTransactionCommit } from "./monitor.js";
import { checkResolvedProfileBinding, resolveLiveProfile } from "./profiles.js";
import type { MlDsaV2TxSigner } from "./signing.js";
import { cccTransactionToWire } from "./wire.js";

/* ── store boundary (implemented by @cemp/database repositories) ─────────── */

export interface OutgoingTxRecord {
  readonly txHash: string;
  readonly state: string;
}

/** Narrow persistence boundary — cemp-database implements this (rule 14 style). */
export interface PublicationStore {
  transitionMessage(messageRowId: number, to: string): Promise<void>;
  setMessageChainRef(
    messageRowId: number,
    ref: { txHash: string; outpointIndex: number },
  ): Promise<void>;
  recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string;
    submittedAtMs?: number;
  }): Promise<void>;
  markOutgoingTxState(txHash: string, state: string, committedAtMs?: number): Promise<void>;
  /** Latest outgoing-tx record for a purpose string, for resume-after-crash. */
  findOutgoingTxByPurpose(purpose: string): Promise<OutgoingTxRecord | undefined>;
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

  constructor(code: PublicationErrorCode, userMessage: string, cause?: unknown) {
    super(`${code}: ${userMessage}`, cause === undefined ? undefined : { cause });
    this.name = "PublicationError";
    this.code = code;
    this.userMessage = userMessage;
  }
}

/** Classify a pipeline failure into a user-readable publication error. */
export function classifyPublishError(error: unknown): PublicationError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PublicationError) {
    return error;
  }
  if (message.includes("no live profile cell") || message.includes("failed validation")) {
    return new PublicationError(
      "profile-not-found",
      "This contact's profile could not be found. Ask them to check their profile is still active.",
      error,
    );
  }
  if (message.includes("capacity") || message.includes("Insufficient")) {
    return new PublicationError(
      "insufficient-capacity",
      "Not enough balance to cover this message. Top up your messaging capacity and try again.",
      error,
    );
  }
  if (message.includes("timed out")) {
    return new PublicationError(
      "commit-timeout",
      "Still waiting for network confirmation. The message is saved — check back shortly.",
      error,
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
    );
  }
  if (message.includes("rejected")) {
    return new PublicationError(
      "rejected-by-node",
      "The network rejected this message. It has been saved — try again in a moment.",
      error,
    );
  }
  return new PublicationError(
    "internal",
    "Something went wrong while sending. The message is saved.",
    error,
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
      // between journal and monitor, or an app restart mid-flight).
      const existing = await store.findOutgoingTxByPurpose(purpose);
      if (existing !== undefined) {
        broadcast = true;
        return await this.#monitor(input.messageRowId, existing.txHash, true, input.timeoutMs);
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
      // RULE 6: journal (tx record + chain ref) BEFORE broadcast.
      await store.recordOutgoingTx({
        txHash,
        purpose,
        state: "submitted",
        feeShannon: built.estimatedFee.toString(),
        submittedAtMs: Date.now(),
      });
      await store.setMessageChainRef(input.messageRowId, { txHash, outpointIndex: 0 });

      const wire = cccTransactionToWire(signed);
      const accepted = await this.#deps.client.sendTransaction(wire);
      if (accepted !== txHash) {
        throw new CempCkbError(
          "publisher",
          "node returned a tx hash different from the signed transaction",
        );
      }
      broadcast = true;

      await store.transitionMessage(input.messageRowId, "pending");
      return await this.#monitor(input.messageRowId, txHash, false, input.timeoutMs);
    } catch (error) {
      const publicationError = classifyPublishError(error);
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
  ): Promise<PublishResult> {
    const { store } = this.#deps;
    const commit = await waitForTransactionCommit(this.#deps.client, txHash, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    void commit;
    await store.markOutgoingTxState(txHash, "committed", Date.now());
    await store.setMessageChainRef(messageRowId, { txHash, outpointIndex: 0 });
    await store.transitionMessage(messageRowId, "committed");
    await store.transitionMessage(messageRowId, "available_on_chain");
    return { txHash, outPoint: { txHash, index: 0 }, committed: true, resumed };
  }
}
