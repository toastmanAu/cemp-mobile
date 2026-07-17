# @cemp/database

Encrypted local database for CEMP Mobile (spec §11, Phase 6). Platform-neutral
TypeScript: repositories and the migration runner talk only to the
`SqliteAdapter` interface — never to a concrete SQLite driver — so the Android
SQLCipher adapter and the Node reference adapter are interchangeable
(AGENTS.md rule 14). No `Buffer`, no `node:*` at the package root; the Node
adapter is exported from the `./node` subpath only.

Implements Phase 6 tasks 1–6 (migrations; contact, conversation, message,
attachment and watched-outpoint repositories) and task 13 (backup/export
design — see below).

## Layout

| Module                  | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `src/adapter.ts`        | `SqliteAdapter` async interface (positional `?` params only).                   |
| `src/node.ts`           | `NodeSqliteAdapter` over `node:sqlite` (`:memory:` or file) — `./node` subpath. |
| `src/migrate.ts`        | Ordered, transactional migrations + `cemp_schema_migrations` bookkeeping.       |
| `src/schema.ts`         | `SCHEMA_VERSION` (currently 1) + table-name constants.                          |
| `src/message-states.ts` | The §11 outgoing/incoming state machines as pure functions.                     |
| `src/repositories/`     | `contacts`, `conversations`, `messages`, `attachments`, `watched-outpoints`.    |

## Schema v1 (spec §11)

All §11 core tables exist: `wallets`, `wallet_balances`, `accounts`,
`profiles`, `contacts`, `conversations`, `messages`, `message_chain_refs`,
`attachments`, `attachment_chunks`, `receipts`, `outgoing_transactions`,
`reclaim_groups`, `watched_outpoints`, `sync_cursors`, `network_endpoints`,
`security_events`, `settings`. Design decisions:

- CKB capacities/fees are u64 shannon, stored as decimal TEXT (exceeds
  `Number.MAX_SAFE_INTEGER`).
- `messages.logical_message_id` is UNIQUE — the idempotency key for retries
  (rule 5): a duplicate insert returns the existing row.
- One conversation per contact (`conversations.contact_id` UNIQUE).
- Keyset pagination (`id < cursor`) for message history — stable under
  concurrent inserts, unlike OFFSET.
- The conversation list the shell consumes (preview + unread count, ordered
  by activity) is ONE query with correlated subqueries, not an N+1 loop.
- Foreign keys are enforced (`PRAGMA foreign_keys = ON`).

## Message states (spec §11)

"All state transitions should be idempotent and persisted." The state machines
are encoded in `message-states.ts` and enforced by
`MessageRepository.transitionState`:

- outgoing: `draft → queued → encrypting → building_transaction →
awaiting_signature → submitting → pending → committed → available_on_chain →
downloaded_by_recipient → acknowledged → reclaim_queued → reclaim_pending →
reclaimed`; `failed` from any in-flight state, `expired` from pre-commit.
- incoming: `discovered → downloading → decrypting → received → displayed →
response_queued → response_sent → awaiting_remote_reclaim →
remote_reclaimed`; `invalid` from any non-terminal state.

Illegal transitions throw `DatabaseError("illegal-state-transition")`; a
transition to the CURRENT state is a persisted no-op (idempotent
re-application after a crash mid-transition).

## Encryption

- **Android (production):** SQLCipher with `PRAGMA key` fed from the vault —
  `@cemp/secure-vault` `getDatabaseKey()` (derived from the unlocked seed) or
  `unwrapDatabaseKey()` (the same 32 bytes from the keystore-wrapped
  `cemp.dbkey` blob). The database cannot be opened without the wrapped key
  (Phase 3 exit criterion). The adapter ships with the Android bootstrap; the
  `SqliteAdapter` constructor seam already documents the `key` option.
- **Node (this repo, tests/tooling):** PLAINTEXT. `node:sqlite` has no
  SQLCipher, so file-backed Node databases are unencrypted on disk. Never put
  real user data through the Node adapter outside tests.

## Backup / export design (Phase 6 task 13)

**Backup.** The database file is already the backup unit: it is fully
encrypted at rest (Android/SQLCipher), so copying `cemp.db` to user-chosen
external storage leaks nothing without the vault. Restore = place the file
back and open it with the same vault (`unwrapDatabaseKey()`). The wrapped key
never leaves the platform keystore, and the vault's mnemonic remains the
ultimate recovery path (the DB key is derived from the seed).

**Export.** There is deliberately **no plaintext-export API** anywhere in this
package (a test asserts the public surface has no export/dump function).
Exporting conversations as plaintext files would violate rule 3 (no permanent
plaintext messages outside the encrypted database). If a user-facing export is
ever added, it must be an encrypted archive (fresh password → new KEK →
AES-256-GCM container, versioned per rule 13) — never raw rows.

## Migrations

Append-only `MIGRATIONS` list in `src/migrate.ts`. Every schema change =
new entry with the next explicit version + `SCHEMA_VERSION` bump (AGENTS.md).
Re-opening an up-to-date database applies nothing; a database stamped with an
unknown version is refused, never silently repaired.

## What later phases consume

- Phase 7 (text publication): `MessageRepository` states + `setChainRef`,
  `OutgoingTransaction` table, `logical_message_id` idempotency.
- Phase 9 (background sync): `listByState`, `watched_outpoints`,
  `sync_cursors`, `reclaim_groups`.
- Phase 10 (images): `attachments` + `attachment_chunks`.
