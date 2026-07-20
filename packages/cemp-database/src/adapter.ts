/**
 * SQLite adapter boundary (AGENTS.md rule 14).
 *
 * The repositories in this package talk only to this async interface — never
 * to a concrete SQLite driver — so Android SQLCipher (apps/android, later
 * phase) and the Node `node:sqlite` reference adapter (`./node` subpath) are
 * interchangeable. The interface is async even though `node:sqlite` is
 * synchronous: Android drivers are inherently asynchronous.
 *
 * Encryption: adapters accept an optional `key` at construction. On Android
 * it becomes the SQLCipher `PRAGMA key`, fed from the vault
 * (`@cemp/secure-vault` `getDatabaseKey()` / `unwrapDatabaseKey()`) — the
 * database cannot be opened without the wrapped key (Phase 3 exit
 * criterion). The Node reference adapter is PLAINTEXT (node:sqlite has no
 * SQLCipher) and is for tests/tooling only.
 *
 * Parameter style: positional `?` placeholders only. Repositories NEVER
 * interpolate values into SQL text (rule 4 cuts both ways).
 */

/** Values bindable to `?` placeholders. */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParams = readonly SqlValue[];

/** A result row as a column-name → value record. */
export type SqlRow = Record<string, SqlValue | undefined>;

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export interface SqliteAdapter {
  /** Execute one or more statements without parameters (DDL, PRAGMAs). */
  exec(sql: string): Promise<void>;

  /** Execute a write statement; reports affected rows and the rowid. */
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>;

  /** Execute a query returning at most one row (`undefined` when empty). */
  get(sql: string, params?: SqlParams): Promise<SqlRow | undefined>;

  /** Execute a query returning all rows. */
  all(sql: string, params?: SqlParams): Promise<SqlRow[]>;

  /**
   * Run `fn` inside BEGIN IMMEDIATE … COMMIT, rolling back on any throw.
   *
   * Concurrent calls on the same adapter are serialized (queued on an
   * internal mutex) rather than merged: each call still gets its own
   * independent BEGIN/COMMIT, so a failing call rolls back only its own
   * work, never another caller's. NOT reentrant — calling `transaction()`
   * again from within a `transaction()` callback on the same adapter
   * deadlocks. No current caller nests (verified across every `.transaction(`
   * call site in this package); if a future caller needs reentrant nesting,
   * that is a new requirement to design for explicitly, not something this
   * method supports implicitly.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Close the database. Further calls reject. */
  close(): Promise<void>;
}
