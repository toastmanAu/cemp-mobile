/**
 * Sender-authenticity presentation for a chat row (ADR 0007 §8, resolved
 * question 4). Pure mapping, no React Native:
 *
 * - `verified` (v3, signature checked) and outgoing / pre-upgrade rows: no
 *   extra UI.
 * - `legacy-unverified` (a v1/v2 message): the body is shown with the label
 *   "Unverified (legacy)".
 * - `key-changed-blocking`: a blocking card; the body is never shown (none
 *   is stored).
 *
 * An unknown status from a newer schema fails CLOSED to the blocking card.
 * Rule 15: no blockchain terminology in the copy.
 */

import type { MessageAuthStatus, MessageDirection } from "@cemp/database";

export const LEGACY_UNVERIFIED_LABEL = "Unverified (legacy)";

export type SenderAuthenticityPresentation =
  | { readonly kind: "none" }
  | { readonly kind: "label"; readonly label: string }
  | {
      readonly kind: "blocking-card";
      readonly title: string;
      readonly body: string;
      readonly showBody: false;
    };

const KEY_CHANGED_CARD: SenderAuthenticityPresentation = {
  kind: "blocking-card",
  title: "Security key changed",
  body:
    "A message arrived for this contact under a security key that does not match the one " +
    "you saved, and the change could not be proven. It was not opened. Verify this " +
    "contact's fingerprint with them in person or over another channel before trusting " +
    "new messages.",
  showBody: false,
};

export function senderAuthenticityPresentation(message: {
  readonly direction: MessageDirection;
  readonly authStatus: MessageAuthStatus | null;
}): SenderAuthenticityPresentation {
  if (message.direction === "outgoing" || message.authStatus === null) {
    return { kind: "none" };
  }
  switch (message.authStatus) {
    case "verified":
      return { kind: "none" };
    case "legacy-unverified":
      return { kind: "label", label: LEGACY_UNVERIFIED_LABEL };
    case "key-changed-blocking":
      return KEY_CHANGED_CARD;
    default:
      return KEY_CHANGED_CARD;
  }
}
