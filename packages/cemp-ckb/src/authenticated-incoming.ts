/**
 * Authenticated incoming messages (ADR 0007 §6).
 *
 * `AuthenticatedIncoming` is the ONLY input `processAcknowledgements` and the
 * contact upsert accept for v3 traffic. It is minted in exactly one place —
 * {@link authenticateIncomingV3}, after `AuthenticatedSenderResolver`
 * returned trusted / rotation-verified / unknown-signed — so unverified
 * input cannot reach those functions by accident:
 *
 * - at compile time, through a `unique symbol` brand no other module can
 *   name, and
 * - at run time, through a module-private registry: a spread or
 *   `JSON`-round-tripped copy is NOT registered, and minted objects are
 *   frozen so their sender cannot be edited after verification.
 *
 * `LegacyIncoming` brands v1/v2 messages from `processIncomingText`. It
 * confers NO sender authenticity: its content is "Unverified (legacy)", and
 * only its v2 receipts count, each one authenticated independently by its
 * ADR 0006 proof of decryption.
 */

import type { IncomingReceipt, IncomingTextMessage, UnverifiedIncomingV3 } from "./incoming.js";
import type { AuthenticatedSenderResolver, SenderVerdict } from "./sender-resolver.js";

declare const AUTHENTICATED: unique symbol;
declare const LEGACY: unique symbol;

/** The verdicts under which a v3 message is accepted as authenticated. */
export type AuthenticatedVerdict = Extract<
  SenderVerdict,
  { kind: "trusted" | "rotation-verified" | "unknown-signed" }
>;

/** A v3 message whose signature verified under a resolved sender key. */
export type AuthenticatedIncoming = IncomingTextMessage & {
  readonly protocolVersion: 3;
  readonly verdict: AuthenticatedVerdict;
  /** ckbHash of the verifying key, hex — stored with the message row (ADR §5). */
  readonly verifyingKeyHashHex: string;
  readonly [AUTHENTICATED]: true;
};

/** A v1/v2 message: content unverified (legacy); receipts proven per entry. */
export type LegacyIncoming = IncomingTextMessage & {
  readonly protocolVersion: 1 | 2;
  readonly [LEGACY]: true;
};

/** Anything `processAcknowledgements` will look at. */
export type ReceiptSource = AuthenticatedIncoming | LegacyIncoming;

const authenticatedRegistry = new WeakSet<object>();
const legacyRegistry = new WeakSet<object>();

/** True only for objects minted by {@link authenticateIncomingV3}. */
export function isAuthenticatedIncoming(value: unknown): value is AuthenticatedIncoming {
  return typeof value === "object" && value !== null && authenticatedRegistry.has(value);
}

/** True only for objects minted by `processIncomingText`. */
export function isLegacyIncoming(value: unknown): value is LegacyIncoming {
  return typeof value === "object" && value !== null && legacyRegistry.has(value);
}

function frozenReceipts(receipts: readonly IncomingReceipt[]): readonly IncomingReceipt[] {
  return Object.freeze(receipts.map((r) => Object.freeze({ ...r })));
}

/**
 * Internal: brand a v1/v2 message. Called by `processIncomingText` only;
 * not re-exported from the package entry point (tests use the testing
 * subpath). Refuses anything that is not version 1 or 2.
 */
export function internalMintLegacyIncoming(message: IncomingTextMessage): LegacyIncoming {
  if (message.protocolVersion !== 1 && message.protocolVersion !== 2) {
    throw new Error("internalMintLegacyIncoming: only protocol versions 1 and 2 are legacy");
  }
  const minted = Object.freeze({ ...message, receipts: frozenReceipts(message.receipts) });
  legacyRegistry.add(minted);
  return minted as LegacyIncoming;
}

export type AuthenticationOutcome =
  | { readonly kind: "authenticated"; readonly message: AuthenticatedIncoming }
  | {
      readonly kind: "key-changed-blocking";
      /** The known contact whose pinned key no longer verifies. */
      readonly contactId: number;
      readonly claimedSenderProfileIdHex: string;
      readonly messageId: Uint8Array;
      readonly reason: string;
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "deferred"; readonly reason: string; readonly notFound?: true };

/**
 * Resolve the sender of a decrypted v3 message and verify its signature
 * (ADR 0007 §5–§6). The single mint of {@link AuthenticatedIncoming}.
 * Secrets: on any outcome other than `authenticated` the attachment and
 * receipt keys of `unverified` are wiped here, because nothing downstream
 * will ever see them.
 */
export async function authenticateIncomingV3(
  unverified: UnverifiedIncomingV3,
  resolver: Pick<AuthenticatedSenderResolver, "resolve">,
): Promise<AuthenticationOutcome> {
  let verdict: SenderVerdict;
  try {
    verdict = await resolver.resolve(unverified.opened);
  } catch (e) {
    wipe(unverified);
    // A resolver that throws (local DB, unexpected bug) never authenticates.
    return { kind: "deferred", reason: e instanceof Error ? e.message : String(e) };
  }
  if (
    verdict.kind === "trusted" ||
    verdict.kind === "rotation-verified" ||
    verdict.kind === "unknown-signed"
  ) {
    if (verdict.senderProfileIdHex !== hexOf(unverified.message.senderProfileId)) {
      wipe(unverified);
      return { kind: "rejected", reason: "internal: verdict names another sender" };
    }
    const minted = Object.freeze({
      ...unverified.message,
      protocolVersion: 3 as const,
      receipts: frozenReceipts(unverified.message.receipts),
      verdict,
      verifyingKeyHashHex: verdict.verifyingKeyHashHex,
    });
    authenticatedRegistry.add(minted);
    return { kind: "authenticated", message: minted as unknown as AuthenticatedIncoming };
  }
  wipe(unverified);
  if (verdict.kind === "key-changed-blocking") {
    return {
      kind: "key-changed-blocking",
      contactId: verdict.contactId,
      claimedSenderProfileIdHex: verdict.claimedSenderProfileIdHex,
      messageId: unverified.message.messageId,
      reason: verdict.reason,
    };
  }
  return verdict;
}

function wipe(unverified: UnverifiedIncomingV3): void {
  unverified.message.attachmentKey.fill(0);
  unverified.message.receiptKey?.fill(0);
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
