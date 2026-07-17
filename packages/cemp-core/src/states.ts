/**
 * Message lifecycle states (spec §11). All transitions must be idempotent
 * and persisted (AGENTS.md rule 5); commitment alone never implies delivery
 * (rule 7).
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

/** Receipt status codes carried in encrypted receipts (spec §8). */
export const RECEIPT_STATUS = {
  Unknown: 0x00,
  Downloaded: 0x01,
  Decrypted: 0x02,
  Displayed: 0x03,
  Replied: 0x04,
  AttachmentDownloaded: 0x05,
  Rejected: 0x06,
} as const;
export type ReceiptStatusName = keyof typeof RECEIPT_STATUS;
export type ReceiptStatusCode = (typeof RECEIPT_STATUS)[ReceiptStatusName];

/**
 * User-facing presentation states (spec §2.1). Blockchain terminology stays
 * out of the ordinary chat workflow (AGENTS.md rule 15).
 */
export const USER_FACING_STATE = {
  Preparing: "Preparing",
  Sending: "Sending",
  Pending: "Pending",
  Sent: "Sent",
  Received: "Received",
  Cleared: "Cleared",
  Failed: "Failed",
  LowBalance: "Messaging balance low",
} as const;
export type UserFacingState = (typeof USER_FACING_STATE)[keyof typeof USER_FACING_STATE];
