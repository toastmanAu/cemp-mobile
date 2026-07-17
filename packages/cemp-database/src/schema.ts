/**
 * Local database schema constants (spec §11).
 *
 * The database is encrypted SQLite (SQLCipher or equivalent) with the key
 * wrapped by the platform keystore. Every schema change requires a migration
 * with an explicit version bump (AGENTS.md conventions).
 */

export const SCHEMA_VERSION = 1;

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
