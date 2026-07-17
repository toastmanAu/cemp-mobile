/**
 * Chat composer view-model (spec Phase 6 task 10).
 *
 * Turns draft text into a persisted outgoing message: `send()` inserts the
 * message in state `draft` and immediately queues it (`draft → queued`), so
 * the Phase 7 publication worker can pick it up after any crash. The
 * `logical_message_id` is generated here — a random 128-bit hex id — making
 * send idempotent across retries (rule 5).
 *
 * The text cap is the protocol's `V1_LIMITS.maxTextBytes` measured in UTF-8
 * BYTES, not characters — what the wire format limits.
 */

import { codec } from "@cemp/core";
import { randomBytes } from "@cemp/crypto";
import type { Message, MessageRepository } from "@cemp/database";

const textEncoder = new TextEncoder();

/** The protocol's text cap (UTF-8 bytes) — `V1_LIMITS.maxTextBytes`. */
const MAX_TEXT_BYTES = codec.V1_LIMITS.maxTextBytes;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ComposerStatus = "editing" | "sending" | "error";

export class ChatComposerViewModel {
  readonly #messages: MessageRepository;
  readonly #conversationId: number;
  readonly #listeners = new Set<() => void>();

  #text = "";
  #status: ComposerStatus = "editing";
  #error: string | null = null;

  constructor(messages: MessageRepository, conversationId: number) {
    this.#messages = messages;
    this.#conversationId = conversationId;
  }

  get text(): string {
    return this.#text;
  }

  get status(): ComposerStatus {
    return this.#status;
  }

  /** Non-secret, user-presentable failure summary (e.g. "message too long"). */
  get error(): string | null {
    return this.#error;
  }

  /** UTF-8 byte length of the current draft (the protocol's unit). */
  get byteLength(): number {
    return textEncoder.encode(this.#text).length;
  }

  get maxBytes(): number {
    return MAX_TEXT_BYTES;
  }

  get canSend(): boolean {
    return (
      this.#status !== "sending" &&
      this.#text.trim().length > 0 &&
      this.byteLength <= MAX_TEXT_BYTES
    );
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  setText(text: string): void {
    this.#text = text;
    if (this.#status === "error") {
      this.#status = "editing";
      this.#error = null;
    }
    this.#notify();
  }

  /** Restore an existing draft message into the composer for editing. */
  resumeDraft(message: Message): void {
    if (message.direction !== "outgoing" || message.state !== "draft") {
      throw new Error("resumeDraft: only outgoing drafts can be edited");
    }
    this.#text = message.body ?? "";
    this.#status = "editing";
    this.#error = null;
    this.#notify();
  }

  /**
   * Queue the draft for publication. Returns the persisted message, or
   * `undefined` when the draft is empty/oversized (no-op, error recorded).
   */
  async send(): Promise<Message | undefined> {
    const body = this.#text.trim();
    if (this.#status === "sending" || body.length === 0) {
      return undefined;
    }
    if (textEncoder.encode(body).length > MAX_TEXT_BYTES) {
      this.#status = "error";
      this.#error = `message exceeds the ${String(MAX_TEXT_BYTES)}-byte protocol limit`;
      this.#notify();
      return undefined;
    }
    this.#status = "sending";
    this.#error = null;
    this.#notify();
    try {
      const message = await this.#messages.insert({
        conversationId: this.#conversationId,
        direction: "outgoing",
        body,
        logicalMessageId: bytesToHex(randomBytes(16)),
      });
      const queued = await this.#messages.transitionState(message.id, "queued");
      this.#text = "";
      this.#status = "editing";
      this.#notify();
      return queued;
    } catch (e) {
      this.#status = "error";
      this.#error = e instanceof Error ? e.message : "send failed";
      this.#notify();
      return undefined;
    }
  }
}
