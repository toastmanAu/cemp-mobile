/**
 * The transport-agnostic incoming pipeline (ADR 0007 §6; docs/lora-transport
 * Phase L3). Chain discovery and the LoRa gateway poll both feed
 * {@link ingestIncomingCellData}; the proof of the sender is inside the
 * envelope, so both transports get the same verdicts.
 *
 *   disposition check → pre-decryption budget (global per sync + per funding
 *   lock) → decrypt + key-free checks → [v3] resolve sender key + verify
 *   signature → block list / per-sender rate limit / contact / insert /
 *   notify (AUTHENTICATED sender only) → receipts → auto-ack
 *
 * Legacy v1/v2 content is stored with the "Unverified (legacy)" label, only
 * in an EXISTING contact's conversation (an unverified claim never creates a
 * contact), never notified and never auto-acked. v2 receipts with valid ADR
 * 0006 proofs are still applied.
 */

import { ACCEPT_LEGACY_UNVERIFIED_CONTENT, ckbHash, codec, formatFingerprint } from "@cemp/core";
import {
  authenticateIncomingV3,
  fundingLockHash,
  incomingLogicalMessageId,
  isAuthenticatedIncoming,
  openIncoming,
  type AuthenticatedIncoming,
  type AuthenticatedSenderResolver,
  type IncomingTextMessage,
  type LegacyIncoming,
  type PinnedSender,
  type PinnedSenderLookup,
} from "@cemp/ckb";
import { checkManifest } from "@cemp/images";
import type { Contact, ContactRepository, DispositionKey } from "@cemp/database";
import type { SyncWorkerDeps } from "./workers.js";

/** Default pre-decryption budgets (ADR 0007 resolved question 3). */
export const PRE_DECRYPT_LIMITS = {
  /** Cells decrypted per sync tick, across all senders. */
  perSync: 200,
  /** Cells decrypted per sync tick from one funding lock (or one gateway). */
  perFundingLock: 20,
} as const;

/** The per-sender rate-limit bucket that legacy (unverified) content shares. */
export const LEGACY_RATE_BUCKET = "legacy-unverified";

/**
 * Per-tick work budget charged BEFORE any decryption. A fresh one is made
 * for every discovery/LoRa tick; it is not persisted (it bounds work per
 * tick, while the persisted per-sender limiter bounds traffic over time).
 */
export class PreDecryptBudget {
  #global: number;
  readonly #perKey: number;
  readonly #used = new Map<string, number>();
  readonly #fundingCache = new Map<string, string>();

  constructor(limits: { perSync: number; perFundingLock: number } = PRE_DECRYPT_LIMITS) {
    this.#global = limits.perSync;
    this.#perKey = limits.perFundingLock;
  }

  /** Consume one unit for `fundingKey`; false when either budget is spent. */
  take(fundingKey: string): boolean {
    const used = this.#used.get(fundingKey) ?? 0;
    if (this.#global < 1 || used >= this.#perKey) {
      return false;
    }
    this.#global -= 1;
    this.#used.set(fundingKey, used + 1);
    return true;
  }

  /** Funding-lock lookups are cached per tick (one per creating tx). */
  cachedFunding(txHash: string): string | undefined {
    return this.#fundingCache.get(txHash);
  }

  rememberFunding(txHash: string, key: string): void {
    this.#fundingCache.set(txHash, key);
  }
}

/** The source of one envelope: a chain outpoint, or a LoRa gateway. */
export type IngestSource = { readonly txHash: string; readonly outpointIndex: number } | null;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Chain/RPC hex is hostile input (rule 4).
  if (bare.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(bare)) {
    throw new Error(`ingest: invalid hex string of length ${bare.length}`);
  }
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/** Adapt the contacts table to the resolver's pinned-key view. */
export function contactPinnedSenderLookup(contacts: ContactRepository): PinnedSenderLookup {
  return {
    async findByProfileId(profileIdHex: string): Promise<PinnedSender | undefined> {
      const contact = await contacts.getByProfileId(profileIdHex);
      if (contact === undefined) return undefined;
      const security = await contacts.getProfileSecurity(contact.id);
      const key = security?.mlDsaPublicKey ?? null;
      return {
        contactId: contact.id,
        profileIdHex,
        mlDsaPublicKey: key !== null && key.length === 1952 ? key : null,
      };
    },
  };
}

/**
 * Ingest one envelope from any transport. `gatewaySource` names the LoRa
 * gateway for the per-source budget when `source` is null.
 */
export async function ingestIncomingCellData(
  deps: SyncWorkerDeps,
  ownProfileId: Uint8Array,
  cellDataHex: string,
  source: IngestSource,
  budget: PreDecryptBudget = new PreDecryptBudget(),
  gatewaySource = "lora:unknown-gateway",
): Promise<void> {
  const cellData = hexToBytes(cellDataHex);
  const key: DispositionKey =
    source === null
      ? { txHash: `lora:${bytesToHex(ckbHash(cellData))}`, outpointIndex: -1 }
      : source;
  const now = Date.now();
  const previous = await deps.dispositions.get(key);
  if (previous?.disposition === "rejected") {
    return;
  }
  if (previous?.disposition === "deferred" && previous.nextAttemptAtMs > now) {
    return;
  }
  // Known-good cells are re-run (receipts, review E8) without charging the
  // pre-decryption budget; anything new is charged first.
  if (previous?.disposition !== "ingested") {
    let fundingKey: string;
    if (source === null) {
      fundingKey = gatewaySource;
    } else {
      const cached = budget.cachedFunding(source.txHash);
      if (cached !== undefined) {
        fundingKey = cached;
      } else {
        try {
          fundingKey = `lock:${await fundingLockHash(deps.client, source.txHash)}`;
        } catch {
          await deps.dispositions.markDeferred(key, now);
          return;
        }
        budget.rememberFunding(source.txHash, fundingKey);
      }
    }
    if (!budget.take(fundingKey)) {
      return; // over budget this tick: untouched, retried next tick
    }
  }

  let opened;
  try {
    opened = openIncoming({ cellData, ownKemSecretKey: deps.ownKemSecretKey, ownProfileId });
  } catch (error) {
    await deps.dispositions.markRejected(key, now);
    throw error;
  }
  if (opened.kind === "legacy") {
    await withWipedKeys(opened.message, () => ingestLegacy(deps, opened.message, source));
    await deps.dispositions.markIngested(key, now);
    return;
  }
  const outcome = await authenticateIncomingV3(opened.unverified, deps.senderResolver);
  switch (outcome.kind) {
    case "deferred":
      await deps.dispositions.markDeferred(key, now, source === null ? cellData : null, {
        notFound: outcome.notFound === true,
      });
      return;
    case "rejected":
      await deps.dispositions.markRejected(key, now);
      return;
    case "key-changed-blocking":
      await storeKeyChangedBlocking(deps, outcome.contactId, outcome.messageId);
      await deps.dispositions.markIngested(key, now);
      return;
    case "authenticated":
      await withWipedKeys(outcome.message, () =>
        ingestAuthenticated(deps, outcome.message, source),
      );
      await deps.dispositions.markIngested(key, now);
      return;
  }
}

async function withWipedKeys(
  message: IncomingTextMessage,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } finally {
    // The keys now live in the encrypted database where they are needed (or
    // were never needed); drop the in-memory copies.
    message.attachmentKey.fill(0);
    message.receiptKey?.fill(0);
  }
}

/* ── authenticated (v3) ──────────────────────────────────────────────────── */

/** The contact an authenticated verdict names, without creating one. */
function verdictContactId(incoming: AuthenticatedIncoming): number | null {
  return incoming.verdict.contactId;
}

async function ingestAuthenticated(
  deps: SyncWorkerDeps,
  incoming: AuthenticatedIncoming,
  source: IngestSource,
): Promise<void> {
  const sender = incoming.verdict.senderProfileIdHex;
  const knownContactId = verdictContactId(incoming);
  // Block list on the AUTHENTICATED sender (ADR 0007 §6).
  if (knownContactId !== null && (await deps.contacts.isBlocked(knownContactId))) {
    return;
  }
  // A pure acknowledgement (empty body + receipts) advances OUR outgoing
  // messages but is never shown and never itself acked. Not rate-limited:
  // an ack per delivered message is legitimate.
  if (incoming.text.length === 0 && incoming.receipts.length > 0) {
    await deps.lifecycle.processAcknowledgements(incoming);
    return;
  }
  // Per-sender rate limit, keyed on the authenticated sender.
  if (!(await deps.rateLimiter.consume("incoming", sender))) {
    return;
  }
  const contact = await upsertAuthenticatedContact(deps.contacts, incoming);
  const conversation = await deps.conversations.getOrCreateForContact(contact.id);
  const inserted = await deps.messages.insert({
    conversationId: conversation.id,
    direction: "incoming",
    body: incoming.text,
    logicalMessageId: incomingLogicalMessageId(incoming.messageId),
  });
  if (inserted.authStatus === null) {
    // Recorded BEFORE the advance, so an interrupted row is still
    // identifiable (the healer reads it).
    await deps.messages.setSenderAuthentication(inserted.id, {
      authStatus: "verified",
      senderKeyHashHex: incoming.verifyingKeyHashHex,
    });
  }
  await storeReceiptKey(deps, inserted.id, incoming.receiptKey);
  await storeAttachments(deps, inserted.id, incoming);
  if (STRANDABLE_INCOMING_STATES.has(inserted.state)) {
    await deps.messages.setEnvelopeMessageId(inserted.id, bytesToHex(incoming.messageId));
    if (source !== null) {
      await deps.messages.setChainRef(inserted.id, source);
    }
    await advanceIncomingToReceived(deps, inserted.id, inserted.state, {
      conversationId: conversation.id,
      logicalMessageId: inserted.logicalMessageId,
      notify: true,
      ...(source === null ? {} : { cell: source }),
    });
  }
  // A reply that ALSO carries receipts still advances OUR outgoing messages.
  if (incoming.receipts.length > 0) {
    await deps.lifecycle.processAcknowledgements(incoming);
  }
}

/**
 * Contact upsert (ADR 0007 §6): accepts ONLY an {@link AuthenticatedIncoming}.
 * Display names are never taken from the sender; an unknown sender gets an
 * `unknown-xxxx` contact and never another contact's name or conversation.
 */
export async function upsertAuthenticatedContact(
  contacts: ContactRepository,
  incoming: AuthenticatedIncoming,
): Promise<Contact> {
  if (!isAuthenticatedIncoming(incoming)) {
    throw new Error("upsertAuthenticatedContact: input is not verifier-made");
  }
  const verdict = incoming.verdict;
  const sender = verdict.senderProfileIdHex;
  if (verdict.kind === "trusted") {
    const contact = await contacts.getById(verdict.contactId);
    if (contact === undefined) throw new Error("trusted contact disappeared");
    return contact;
  }
  const pin = async (contactId: number, trustVerdict: string) => {
    const profileId = hexToBytes(sender);
    await contacts.setProfileSecurity(contactId, {
      profileTypeIdHex: sender,
      mlDsaPublicKey: verdict.verifyingKey,
      mlKemPublicKey: verdict.profile.ml_kem_public_key,
      fingerprint: formatFingerprint({
        profileId,
        mlDsaPublicKey: verdict.verifyingKey,
        mlKemPublicKey: verdict.profile.ml_kem_public_key,
      }),
      trustVerdict,
    });
  };
  if (verdict.kind === "rotation-verified") {
    // Re-pin: the contact follows its verified successor profile.
    const updated = await contacts.update(verdict.contactId, { profileIdHex: sender });
    await pin(updated.id, "rotation-verified");
    return updated;
  }
  const existing =
    verdict.contactId !== null
      ? await contacts.getById(verdict.contactId)
      : await contacts.getByProfileId(sender);
  const contact =
    existing ??
    (await contacts.create({ displayName: `unknown-${sender.slice(0, 8)}`, profileIdHex: sender }));
  await pin(contact.id, "first-use");
  return contact;
}

/** A blocking "key changed" card: a row with NO body, never notified or acked. */
async function storeKeyChangedBlocking(
  deps: SyncWorkerDeps,
  contactId: number,
  messageId: Uint8Array,
): Promise<void> {
  const conversation = await deps.conversations.getOrCreateForContact(contactId);
  const row = await deps.messages.insert({
    conversationId: conversation.id,
    direction: "incoming",
    body: null,
    logicalMessageId: incomingLogicalMessageId(messageId),
    state: "invalid",
  });
  if (row.authStatus === null) {
    await deps.messages.setSenderAuthentication(row.id, {
      authStatus: "key-changed-blocking",
      senderKeyHashHex: null,
    });
  }
}

/* ── legacy (v1/v2) ──────────────────────────────────────────────────────── */

async function ingestLegacy(
  deps: SyncWorkerDeps,
  incoming: LegacyIncoming,
  source: IngestSource,
): Promise<void> {
  const claimed = bytesToHex(incoming.senderProfileId);
  if (await deps.contacts.isBlockedByProfileId(claimed)) {
    return;
  }
  // v2 receipts authenticate themselves (ADR 0006 proof); v1 receipts are
  // ignored by processAcknowledgements.
  if (incoming.text.length === 0 && incoming.receipts.length > 0) {
    await deps.lifecycle.processAcknowledgements(incoming);
    return;
  }
  if (ACCEPT_LEGACY_UNVERIFIED_CONTENT) {
    await storeLegacyContent(deps, incoming, claimed, source);
  }
  if (incoming.receipts.length > 0) {
    await deps.lifecycle.processAcknowledgements(incoming);
  }
}

async function storeLegacyContent(
  deps: SyncWorkerDeps,
  incoming: LegacyIncoming,
  claimed: string,
  source: IngestSource,
): Promise<void> {
  // An unverified claim never creates a contact: only an existing contact's
  // conversation can hold a legacy message, and only with the label.
  const contact = await deps.contacts.getByProfileId(claimed);
  if (contact === undefined) {
    return;
  }
  if (!(await deps.rateLimiter.consume("incoming", LEGACY_RATE_BUCKET))) {
    return;
  }
  const conversation = await deps.conversations.getOrCreateForContact(contact.id);
  const inserted = await deps.messages.insert({
    conversationId: conversation.id,
    direction: "incoming",
    body: incoming.text,
    logicalMessageId: incomingLogicalMessageId(incoming.messageId),
  });
  if (inserted.authStatus === null) {
    await deps.messages.setSenderAuthentication(inserted.id, {
      authStatus: "legacy-unverified",
      senderKeyHashHex: null,
    });
  }
  await storeAttachments(deps, inserted.id, incoming);
  if (STRANDABLE_INCOMING_STATES.has(inserted.state)) {
    await deps.messages.setEnvelopeMessageId(inserted.id, bytesToHex(incoming.messageId));
    if (source !== null) {
      await deps.messages.setChainRef(inserted.id, source);
    }
    // No notification and no auto-ack: the sender is not authenticated.
    await advanceIncomingToReceived(deps, inserted.id, inserted.state, {
      conversationId: conversation.id,
      logicalMessageId: inserted.logicalMessageId,
      notify: false,
    });
  }
}

/* ── shared row helpers ──────────────────────────────────────────────────── */

async function storeReceiptKey(
  deps: SyncWorkerDeps,
  rowId: number,
  receiptKey: Uint8Array | null,
): Promise<void> {
  // ADR 0006: keep the recipient's receipt key with the row on first ingest
  // (the ack may be sent after the sender reclaimed the cell).
  if (receiptKey === null) return;
  const stored = await deps.messages.getReceiptKey(rowId);
  if (stored === null) {
    await deps.messages.setReceiptKey(rowId, receiptKey);
  } else {
    stored.fill(0);
  }
}

async function storeAttachments(
  deps: SyncWorkerDeps,
  rowId: number,
  incoming: IncomingTextMessage,
): Promise<void> {
  if (incoming.attachmentManifests.length === 0) return;
  // Persisted exactly once per message (re-scans re-enter this function).
  if ((await deps.attachments.listForMessage(rowId)).length === 0) {
    for (const manifest of incoming.attachmentManifests) {
      // Rule 4: a hostile manifest never reaches the attachments table.
      if (!checkManifest(manifest).ok) continue;
      await deps.attachments.create({
        messageId: rowId,
        kind: "image",
        byteLength: Number(manifest.plaintext_size),
        manifest: codec.encodeAttachmentManifestV1(manifest),
        attachmentKey: incoming.attachmentKey,
      });
    }
  }
  incoming.attachmentKey.fill(0);
}

/**
 * Incoming states from which the advance-to-`received` path can still be
 * driven: the initial state plus the two the multi-transaction advance can be
 * interrupted in.
 */
export const STRANDABLE_INCOMING_STATES: ReadonlySet<string> = new Set([
  "discovered",
  "downloading",
  "decrypting",
]);

const INCOMING_ADVANCE_ORDER = ["discovered", "downloading", "decrypting", "received"] as const;

/**
 * Drive an incoming message from wherever it sits up to `received`; then,
 * only when `notify` is set (an AUTHENTICATED sender), notify and queue the
 * auto-ack. Shared by first ingest and the stranded-message healer.
 */
export async function advanceIncomingToReceived(
  deps: SyncWorkerDeps,
  messageId: number,
  fromState: string,
  context: {
    conversationId: number;
    logicalMessageId: string;
    /** False for legacy (unverified) rows: no notification, no auto-ack. */
    notify: boolean;
    cell?: { txHash: string; outpointIndex: number };
  },
): Promise<void> {
  const startIndex = INCOMING_ADVANCE_ORDER.indexOf(
    fromState as (typeof INCOMING_ADVANCE_ORDER)[number],
  );
  if (startIndex < 0) {
    return;
  }
  for (const next of INCOMING_ADVANCE_ORDER.slice(startIndex + 1)) {
    await deps.messages.transitionState(messageId, next);
  }
  if (!context.notify) {
    return;
  }
  // Generic copy, always — no sender identity or content leaves the app.
  await deps.notifier.post({
    id: `message:${String(messageId)}`,
    channel: "messages",
    title: "CellSend",
    body: "New message. Unlock to view.",
  });
  if (context.cell !== undefined) {
    await queueAcknowledgement(deps, {
      conversationId: context.conversationId,
      originalLogicalId: context.logicalMessageId,
      originalCell: context.cell,
    });
  }
}

/**
 * Queue a receipt-only acknowledgement for a freshly received AUTHENTICATED
 * message (ADR 0005). Idempotent on the `response:` logical id.
 */
async function queueAcknowledgement(
  deps: SyncWorkerDeps,
  input: {
    conversationId: number;
    originalLogicalId: string;
    originalCell: { txHash: string; outpointIndex: number };
  },
): Promise<void> {
  const responseLogicalId = `response:${input.originalLogicalId}`;
  if ((await deps.messages.getByLogicalId(responseLogicalId)) !== undefined) {
    return;
  }
  const row = await deps.messages.insert({
    conversationId: input.conversationId,
    direction: "outgoing",
    body: "",
    logicalMessageId: responseLogicalId,
    state: "queued",
  });
  await deps.messages.setChainRef(row.id, {
    replyToTxHash: input.originalCell.txHash,
    replyToOutpointIndex: input.originalCell.outpointIndex,
  });
}

/** Re-export for the resolver wiring in the composition root. */
export type SenderResolver = Pick<AuthenticatedSenderResolver, "resolve">;
