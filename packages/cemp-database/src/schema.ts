/**
 * Local database schema constants (spec §11).
 *
 * The database is encrypted SQLite (SQLCipher or equivalent) with the key
 * wrapped by the platform keystore. Every schema change requires a migration
 * with an explicit version bump (AGENTS.md conventions).
 *
 * Version history:
 * - 1: initial schema (spec §11 core tables).
 * - 2: profile security (Phase 5) — profiles.previous_profile_id_hex rotation
 *   lineage; contacts profile security material (type id, public keys,
 *   fingerprint, trust verdict).
 * - 3: response/reclaim lifecycle (Phase 8) — messages.envelope_message_id_hex
 *   (receipt/reply matching); outgoing_transactions.capacity_shannon
 *   (reclaim accounting across crash-resume).
 * - 4: background operation (Phase 9) — worker_leases (concurrency control
 *   for workers and reclaim jobs, tasks 9–10). Sync cursors reuse the v1
 *   sync_cursors table.
 * - 5: hardening (Phase 11) — contacts.blocked (block controls);
 *   rate_limits (token buckets for per-contact + global rate limits).
 * - 6: crash-safe journals (review E1) — outgoing_transactions.tx_hex holds
 *   the signed wire transaction so a resume can rebroadcast, never wedge.
 * - 7: one attachment per message (review follow-up) — UNIQUE INDEX on
 *   attachments(message_id) enforces the spec's single-attachment rule.
 * - 8: attachments.attachment_key (review follow-up) — the envelope-derived
 *   incoming attachment key is persisted at discovery (rule 3: the database
 *   is encrypted). Chain re-derivation depended on the sender-reclaimable
 *   message cell (rule 9), which let the sender permanently brick the
 *   receiver's tap-to-download after ack.
 * - 9: attachments.remote_downloaded — the recipient's `0x05
 *   AttachmentDownloaded` receipt (spec §8), which is what permits chunk-cell
 *   reclaim. Reclaiming on the plain `0x01` envelope ack destroyed images
 *   before a lazily-tapped download could ever fetch them.
 * - 10: messages.receipt_key (ADR 0006) — the per-message receipt key. On an
 *   OUTGOING row (stored before broadcast) it verifies the recipient's
 *   receipt proofs; on an INCOMING row (stored at first ingest) it produces
 *   them, possibly after the sender has reclaimed the message cell. NULL for
 *   rows from before the upgrade and for legacy v1 incoming messages.
 * - 11: sender-signed envelopes (ADR 0007) — messages.auth_status
 *   (`verified` | `legacy-unverified` | `key-changed-blocking`; NULL for
 *   outgoing and pre-upgrade rows), messages.sender_key_hash_hex (ckbHash of
 *   the key that verified an incoming v3 message, so history stays
 *   explainable after a rotation), messages.prepared_envelope (the signed
 *   outgoing envelope, journaled so a retry rebroadcasts identical bytes),
 *   and incoming_dispositions (per-cell ingested/rejected/deferred with a
 *   bounded backoff; deferred cells stay undisposed and are retried).
 */

export const SCHEMA_VERSION = 11;

/** Core tables (spec §11). */
export const TABLE_NAMES = [
  "wallets",
  "wallet_balances",
  "accounts",
  "profiles",
  "contacts",
  "conversations",
  "messages",
  "message_chain_refs",
  "attachments",
  "attachment_chunks",
  "receipts",
  "outgoing_transactions",
  "reclaim_groups",
  "watched_outpoints",
  "sync_cursors",
  "network_endpoints",
  "security_events",
  "settings",
  "incoming_dispositions",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];
