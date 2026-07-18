/**
 * Message state machines (spec §11: "All state transitions should be
 * idempotent and persisted").
 *
 * Outgoing (sender side): draft → queued → encrypting → building_transaction
 * → awaiting_signature → submitting → pending → committed → available_on_chain
 * → downloaded_by_recipient → acknowledged → reclaim_queued → reclaim_pending
 * → reclaimed. `failed` is reachable from every in-flight state; `expired`
 * from pre-commit states (TTL). RETRY EDGE (review E1): reclaim_pending →
 * reclaim_queued is the requeue path for a reclaim tx that was journaled but
 * never seen by the network (abandoned — a fresh batch rebuilds with live
 * inputs; it is NOT a state regression, the cell was never consumed).
 *
 * Incoming (recipient side): discovered → downloading → decrypting → received
 * → displayed → response_queued → response_sent → awaiting_remote_reclaim →
 * remote_reclaimed. `invalid` is reachable from every non-terminal state.
 */

export const OUTGOING_MESSAGE_STATES = [
  "draft",
  "queued",
  "encrypting",
  "building_transaction",
  "awaiting_signature",
  "submitting",
  "pending",
  "committed",
  "available_on_chain",
  "downloaded_by_recipient",
  "acknowledged",
  "reclaim_queued",
  "reclaim_pending",
  "reclaimed",
  "expired",
  "failed",
] as const;
export type OutgoingMessageState = (typeof OUTGOING_MESSAGE_STATES)[number];

export const INCOMING_MESSAGE_STATES = [
  "discovered",
  "downloading",
  "decrypting",
  "received",
  "displayed",
  "response_queued",
  "response_sent",
  "awaiting_remote_reclaim",
  "remote_reclaimed",
  "invalid",
] as const;
export type IncomingMessageState = (typeof INCOMING_MESSAGE_STATES)[number];

export type MessageState = OutgoingMessageState | IncomingMessageState;
export type MessageDirection = "outgoing" | "incoming";

/** Terminal states: no legal outbound transitions. */
export const TERMINAL_MESSAGE_STATES: ReadonlySet<MessageState> = new Set([
  "reclaimed",
  "expired",
  "failed",
  "remote_reclaimed",
  "invalid",
]);

const OUTGOING_IN_FLIGHT: readonly OutgoingMessageState[] = [
  "draft",
  "queued",
  "encrypting",
  "building_transaction",
  "awaiting_signature",
  "submitting",
  "pending",
];

/** Legal outgoing transitions (failed reachable from any in-flight state). */
const OUTGOING_TRANSITIONS: Readonly<
  Record<OutgoingMessageState, readonly OutgoingMessageState[]>
> = {
  draft: ["queued", "failed"],
  queued: ["encrypting", "failed", "expired"],
  encrypting: ["building_transaction", "failed"],
  building_transaction: ["awaiting_signature", "failed"],
  awaiting_signature: ["submitting", "failed"],
  submitting: ["pending", "failed"],
  pending: ["committed", "failed", "expired"],
  committed: ["available_on_chain", "failed"],
  available_on_chain: ["downloaded_by_recipient", "failed"],
  downloaded_by_recipient: ["acknowledged", "failed"],
  acknowledged: ["reclaim_queued", "failed"],
  reclaim_queued: ["reclaim_pending", "failed"],
  reclaim_pending: ["reclaimed", "reclaim_queued", "failed"],
  reclaimed: [],
  expired: [],
  failed: [],
};

const INCOMING_TRANSITIONS: Readonly<
  Record<IncomingMessageState, readonly IncomingMessageState[]>
> = {
  discovered: ["downloading", "invalid"],
  downloading: ["decrypting", "invalid"],
  decrypting: ["received", "invalid"],
  received: ["displayed", "invalid"],
  displayed: ["response_queued", "invalid"],
  response_queued: ["response_sent", "invalid"],
  response_sent: ["awaiting_remote_reclaim", "invalid"],
  awaiting_remote_reclaim: ["remote_reclaimed", "invalid"],
  remote_reclaimed: [],
  invalid: [],
};

export function isOutgoingState(state: string): state is OutgoingMessageState {
  return (OUTGOING_MESSAGE_STATES as readonly string[]).includes(state);
}

export function isIncomingState(state: string): state is IncomingMessageState {
  return (INCOMING_MESSAGE_STATES as readonly string[]).includes(state);
}

/** The initial state for a freshly inserted message of `direction`. */
export function initialMessageState(direction: MessageDirection): MessageState {
  return direction === "outgoing" ? "draft" : "discovered";
}

/**
 * Whether `from → to` is a legal transition for `direction`. Same-state is
 * NOT a transition — callers treat it as an idempotent no-op (§11).
 */
export function canTransitionMessage(
  direction: MessageDirection,
  from: MessageState,
  to: MessageState,
): boolean {
  if (direction === "outgoing") {
    return isOutgoingState(from) && isOutgoingState(to) && OUTGOING_TRANSITIONS[from].includes(to);
  }
  return isIncomingState(from) && isIncomingState(to) && INCOMING_TRANSITIONS[from].includes(to);
}

/** All states an in-flight outgoing message can fail from (test/doc aid). */
export function outgoingInFlightStates(): readonly OutgoingMessageState[] {
  return OUTGOING_IN_FLIGHT;
}
