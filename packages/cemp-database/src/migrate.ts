/**
 * Schema migrations (spec §11; AGENTS.md: every schema change requires a
 * migration with an explicit version bump).
 *
 * Migrations are an append-only list of `{version, description, statements}`
 * steps applied in order inside one transaction each, recorded in the
 * `cemp_schema_migrations` bookkeeping table. Re-opening an up-to-date
 * database applies nothing (rule 5 — idempotent). A database stamped with a
 * version this build does not know (e.g. a downgrade) is refused, never
 * silently "repaired".
 */

import type { SqliteAdapter } from "./adapter.js";
import { DatabaseError } from "./errors.js";

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly statements: readonly string[];
}

/**
 * Schema v1 (spec §11 core tables). Design notes:
 * - CKB capacities/fee amounts are u64 shannon — stored as decimal TEXT
 *   because they exceed Number.MAX_SAFE_INTEGER.
 * - Outpoints are (tx_hash CHAR(66), outpoint_index INTEGER) pairs.
 * - `messages.logical_message_id` is UNIQUE: the idempotency key for retries
 *   across crashes/background restarts (rule 5, spec §13).
 * - Timestamps are epoch milliseconds (INTEGER).
 */
const SCHEMA_V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE wallets (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     created_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE wallet_balances (
     wallet_id INTEGER PRIMARY KEY REFERENCES wallets(id),
     total_shannon TEXT NOT NULL,
     available_shannon TEXT NOT NULL,
     reserved_shannon TEXT NOT NULL,
     reclaimable_shannon TEXT NOT NULL,
     pending_shannon TEXT NOT NULL,
     updated_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE accounts (
     id INTEGER PRIMARY KEY,
     wallet_id INTEGER NOT NULL REFERENCES wallets(id),
     label TEXT NOT NULL,
     network TEXT NOT NULL,
     created_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE profiles (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL REFERENCES accounts(id),
     profile_id_hex TEXT NOT NULL UNIQUE,
     type_id_hex TEXT,
     outpoint_tx_hash TEXT,
     outpoint_index INTEGER,
     state TEXT NOT NULL,
     created_at_ms INTEGER NOT NULL,
     updated_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE contacts (
     id INTEGER PRIMARY KEY,
     display_name TEXT NOT NULL,
     notes TEXT NOT NULL DEFAULT '',
     avatar BLOB,
     profile_id_hex TEXT UNIQUE,
     created_at_ms INTEGER NOT NULL,
     updated_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE conversations (
     id INTEGER PRIMARY KEY,
     contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id),
     created_at_ms INTEGER NOT NULL,
     last_activity_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     conversation_id INTEGER NOT NULL REFERENCES conversations(id),
     direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
     state TEXT NOT NULL,
     body TEXT,
     logical_message_id TEXT NOT NULL UNIQUE,
     created_at_ms INTEGER NOT NULL,
     updated_at_ms INTEGER NOT NULL
   )`,
  `CREATE INDEX messages_conversation_id_id ON messages(conversation_id, id)`,
  `CREATE INDEX messages_state ON messages(state)`,
  `CREATE TABLE message_chain_refs (
     id INTEGER PRIMARY KEY,
     message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
     tx_hash TEXT,
     outpoint_index INTEGER,
     reply_to_tx_hash TEXT,
     reply_to_outpoint_index INTEGER
   )`,
  `CREATE TABLE attachments (
     id INTEGER PRIMARY KEY,
     message_id INTEGER NOT NULL REFERENCES messages(id),
     kind TEXT NOT NULL,
     byte_length INTEGER NOT NULL,
     state TEXT NOT NULL,
     manifest BLOB,
     created_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE attachment_chunks (
     id INTEGER PRIMARY KEY,
     attachment_id INTEGER NOT NULL REFERENCES attachments(id),
     chunk_index INTEGER NOT NULL,
     outpoint_tx_hash TEXT,
     outpoint_index INTEGER,
     state TEXT NOT NULL,
     UNIQUE (attachment_id, chunk_index)
   )`,
  `CREATE TABLE receipts (
     id INTEGER PRIMARY KEY,
     message_id INTEGER NOT NULL REFERENCES messages(id),
     receipt_type INTEGER NOT NULL,
     tx_hash TEXT,
     state TEXT NOT NULL,
     created_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE outgoing_transactions (
     id INTEGER PRIMARY KEY,
     tx_hash TEXT NOT NULL UNIQUE,
     purpose TEXT NOT NULL,
     state TEXT NOT NULL,
     fee_shannon TEXT,
     submitted_at_ms INTEGER,
     committed_at_ms INTEGER,
     block_hash TEXT
   )`,
  `CREATE TABLE reclaim_groups (
     id INTEGER PRIMARY KEY,
     state TEXT NOT NULL,
     created_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE watched_outpoints (
     id INTEGER PRIMARY KEY,
     tx_hash TEXT NOT NULL,
     outpoint_index INTEGER NOT NULL,
     purpose TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'watching',
     spent_by_tx_hash TEXT,
     reclaim_group_id INTEGER REFERENCES reclaim_groups(id),
     created_at_ms INTEGER NOT NULL,
     spent_at_ms INTEGER,
     UNIQUE (tx_hash, outpoint_index)
   )`,
  `CREATE TABLE sync_cursors (
     worker TEXT PRIMARY KEY,
     cursor TEXT NOT NULL,
     updated_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE network_endpoints (
     id INTEGER PRIMARY KEY,
     network TEXT NOT NULL,
     kind TEXT NOT NULL,
     url TEXT NOT NULL,
     is_active INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE security_events (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     detail TEXT NOT NULL,
     created_at_ms INTEGER NOT NULL
   )`,
  `CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

/** The ordered, append-only migration list. v1 is the initial schema. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, description: "initial schema (spec §11)", statements: SCHEMA_V1_STATEMENTS },
  {
    version: 2,
    description: "profile security: rotation lineage + contact trust material (Phase 5)",
    statements: [
      "ALTER TABLE profiles ADD COLUMN previous_profile_id_hex TEXT",
      "ALTER TABLE contacts ADD COLUMN profile_type_id_hex TEXT",
      "ALTER TABLE contacts ADD COLUMN ml_dsa_public_key BLOB",
      "ALTER TABLE contacts ADD COLUMN ml_kem_public_key BLOB",
      "ALTER TABLE contacts ADD COLUMN fingerprint TEXT",
      "ALTER TABLE contacts ADD COLUMN trust_verdict TEXT",
    ],
  },
  {
    version: 3,
    description: "response/reclaim lifecycle: envelope message ids + reclaim capacity (Phase 8)",
    statements: [
      "ALTER TABLE messages ADD COLUMN envelope_message_id_hex TEXT",
      "CREATE INDEX messages_envelope_message_id ON messages(envelope_message_id_hex)",
      "ALTER TABLE outgoing_transactions ADD COLUMN capacity_shannon TEXT",
    ],
  },
];

const BOOKKEEPING_DDL = `CREATE TABLE IF NOT EXISTS cemp_schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
)`;

/** The schema version recorded in the database (0 when never migrated). */
export async function currentSchemaVersion(adapter: SqliteAdapter): Promise<number> {
  await adapter.exec(BOOKKEEPING_DDL);
  const row = await adapter.get("SELECT MAX(version) AS v FROM cemp_schema_migrations");
  return row?.v === null || row?.v === undefined ? 0 : Number(row.v);
}

/**
 * Apply all pending migrations in version order. Idempotent (rule 5): an
 * up-to-date database is a no-op. Refuses databases stamped with an unknown
 * (newer or gapped) version rather than guessing.
 */
export async function migrate(adapter: SqliteAdapter): Promise<void> {
  await adapter.exec(BOOKKEEPING_DDL);
  const appliedRows = await adapter.all(
    "SELECT version FROM cemp_schema_migrations ORDER BY version",
  );
  const applied = new Set(appliedRows.map((r) => Number(r.version)));
  const known = new Set(MIGRATIONS.map((m) => m.version));
  for (const version of applied) {
    if (!known.has(version)) {
      throw new DatabaseError(
        "migration-error",
        `database is stamped with unknown schema version ${String(version)}`,
      );
    }
  }
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    await adapter.transaction(async () => {
      for (const statement of migration.statements) {
        await adapter.exec(statement);
      }
      await adapter.run(
        "INSERT INTO cemp_schema_migrations (version, description, applied_at_ms) VALUES (?, ?, ?)",
        [migration.version, migration.description, Date.now()],
      );
    });
  }
}
