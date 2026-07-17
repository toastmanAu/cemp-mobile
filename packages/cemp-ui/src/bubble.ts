/**
 * Message bubble presentation mapping (spec Phase 6 task 11).
 *
 * A pure function from the §11 message state to what a chat bubble shows:
 * status label, spinner, retry affordance. Blockchain terminology stays out
 * of the chat surface (AGENTS.md rule 15) — the user sees "sending", "sent",
 * "delivered", "acknowledged", never "committed" or "outpoint".
 */

import type { MessageDirection, MessageState } from "@cemp/database";

export type BubbleStatus =
  | "draft"
  | "sending"
  | "sent"
  | "delivered"
  | "acknowledged"
  | "reclaimed"
  | "failed"
  | "expired"
  | "receiving"
  | "received"
  | "invalid";

export interface BubblePresentation {
  readonly status: BubbleStatus;
  /** Show an activity spinner (in-flight work). */
  readonly showSpinner: boolean;
  /** Show the retry affordance (user can re-queue). */
  readonly canRetry: boolean;
}

const OUTGOING_MAP: Readonly<Partial<Record<MessageState, BubblePresentation>>> = {
  draft: { status: "draft", showSpinner: false, canRetry: false },
  queued: { status: "sending", showSpinner: true, canRetry: false },
  encrypting: { status: "sending", showSpinner: true, canRetry: false },
  building_transaction: { status: "sending", showSpinner: true, canRetry: false },
  awaiting_signature: { status: "sending", showSpinner: true, canRetry: false },
  submitting: { status: "sending", showSpinner: true, canRetry: false },
  pending: { status: "sent", showSpinner: false, canRetry: false },
  committed: { status: "sent", showSpinner: false, canRetry: false },
  available_on_chain: { status: "sent", showSpinner: false, canRetry: false },
  downloaded_by_recipient: { status: "delivered", showSpinner: false, canRetry: false },
  acknowledged: { status: "acknowledged", showSpinner: false, canRetry: false },
  reclaim_queued: { status: "acknowledged", showSpinner: false, canRetry: false },
  reclaim_pending: { status: "acknowledged", showSpinner: false, canRetry: false },
  reclaimed: { status: "reclaimed", showSpinner: false, canRetry: false },
  expired: { status: "expired", showSpinner: false, canRetry: true },
  failed: { status: "failed", showSpinner: false, canRetry: true },
};

const INCOMING_MAP: Readonly<Partial<Record<MessageState, BubblePresentation>>> = {
  discovered: { status: "receiving", showSpinner: true, canRetry: false },
  downloading: { status: "receiving", showSpinner: true, canRetry: false },
  decrypting: { status: "receiving", showSpinner: true, canRetry: false },
  received: { status: "received", showSpinner: false, canRetry: false },
  displayed: { status: "received", showSpinner: false, canRetry: false },
  response_queued: { status: "received", showSpinner: false, canRetry: false },
  response_sent: { status: "received", showSpinner: false, canRetry: false },
  awaiting_remote_reclaim: { status: "received", showSpinner: false, canRetry: false },
  remote_reclaimed: { status: "received", showSpinner: false, canRetry: false },
  invalid: { status: "invalid", showSpinner: false, canRetry: false },
};

/** Bubble presentation for a persisted message row. */
export function messageBubbleState(message: {
  direction: MessageDirection;
  state: MessageState;
}): BubblePresentation {
  const map = message.direction === "outgoing" ? OUTGOING_MAP : INCOMING_MAP;
  const presentation = map[message.state];
  if (presentation === undefined) {
    // A state from a newer schema than this build understands: show a
    // neutral bubble rather than crash the chat surface.
    return { status: "invalid", showSpinner: false, canRetry: false };
  }
  return presentation;
}
