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
 */

export const SCHEMA_VERSION = 3;

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
] as const;
export type TableName = (typeof TABLE_NAMES)[number];
