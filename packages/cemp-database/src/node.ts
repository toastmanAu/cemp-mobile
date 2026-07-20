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
import { AsyncMutex } from "./async-mutex.js";
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
  readonly #txMutex = new AsyncMutex();
  #closed = false;

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
    // Serialize concurrent callers on the mutex instead of racing on
    // #inTransaction: two callers evaluating a flag before either sets it
    // could both issue BEGIN IMMEDIATE on the same connection. Each queued
    // call still gets its own independent BEGIN/COMMIT — see adapter.ts.
    return await this.#txMutex.runExclusive(async () => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        this.#db.exec("COMMIT");
        return result;
      } catch (e) {
        this.#db.exec("ROLLBACK");
        throw e;
      }
    });
  }

  /**
   * Close the connection, WAITING for any in-flight transaction first.
   *
   * Teardown takes the same mutex `transaction()` uses, so a close racing an
   * in-flight unit of work queues behind it instead of cutting it off. Without
   * this, an auto-lock during a background sync closed the handle mid-
   * transaction and the transaction's COMMIT failed with "the database
   * connection is closed", losing the work.
   *
   * NOT reentrant (see {@link AsyncMutex}): `close()` must never be called
   * from inside a `transaction()` callback or it deadlocks. The only
   * production caller is AppContainer#closeDatabase, which runs at teardown
   * and holds no transaction.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    await this.#txMutex.runExclusive(() => {
      // Re-check under the lock: a concurrent close() may have won the queue.
      if (!this.#closed) {
        this.#db.close();
        this.#closed = true;
      }
      return Promise.resolve();
    });
  }
}
