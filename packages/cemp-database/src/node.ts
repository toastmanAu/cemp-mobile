/**
 * Node reference {@link SqliteAdapter} over `node:sqlite` (Node ≥ 22).
 *
 * Exported via the `./node` subpath — NEVER from the package root — so React
 * Native/Hermes bundlers never resolve `node:sqlite` (AGENTS.md rule 14).
 *
 * PLAINTEXT: `node:sqlite` has no SQLCipher, so file-backed databases are
 * unencrypted on disk. This adapter exists for tests and desktop tooling; the
 * Android SQLCipher adapter (with the vault-wrapped key) is what production
 * uses. See the package README's "Encryption" section.
 */

import { DatabaseSync } from "node:sqlite";
import type { SqlParams, SqlRow, SqlRunResult, SqliteAdapter } from "./adapter.js";
import { DatabaseError } from "./errors.js";

export interface NodeSqliteOptions {
  /** Database path, or ":memory:" (default) for an ephemeral database. */
  readonly path?: string;
}

/** A value node:sqlite hands back for an INTEGER/REAL/TEXT/BLOB column. */
type NodeSqlValue = null | number | bigint | string | Uint8Array;

function toRunResult(raw: {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}): SqlRunResult {
  return {
    changes: Number(raw.changes),
    lastInsertRowid: Number(raw.lastInsertRowid),
  };
}

export class NodeSqliteAdapter implements SqliteAdapter {
  readonly #db: DatabaseSync;
  #closed = false;
  #inTransaction = false;

  constructor(options: NodeSqliteOptions = {}) {
    this.#db = new DatabaseSync(options.path ?? ":memory:");
    // Foreign keys are enforced for every repository write.
    this.#db.exec("PRAGMA foreign_keys = ON");
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DatabaseError("adapter-error", "the database connection is closed");
    }
  }

  async exec(sql: string): Promise<void> {
    this.#assertOpen();
    this.#db.exec(sql);
  }

  async run(sql: string, params: SqlParams = []): Promise<SqlRunResult> {
    this.#assertOpen();
    const stmt = this.#db.prepare(sql);
    return toRunResult(stmt.run(...(params as NodeSqlValue[])));
  }

  async get(sql: string, params: SqlParams = []): Promise<SqlRow | undefined> {
    this.#assertOpen();
    const stmt = this.#db.prepare(sql);
    const row = stmt.get(...(params as NodeSqlValue[]));
    return row === undefined ? undefined : (row as SqlRow);
  }

  async all(sql: string, params: SqlParams = []): Promise<SqlRow[]> {
    this.#assertOpen();
    const stmt = this.#db.prepare(sql);
    return stmt.all(...(params as NodeSqlValue[])) as SqlRow[];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#inTransaction) {
      // Join the outer transaction (current callers never nest; documented
      // on the interface).
      return await fn();
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#inTransaction = true;
    try {
      const result = await fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    } finally {
      this.#inTransaction = false;
    }
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
    return Promise.resolve();
  }
}
