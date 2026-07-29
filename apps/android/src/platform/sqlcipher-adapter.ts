/**
 * SQLCipher {@link SqliteAdapter} for Android over @op-engineering/op-sqlite.
 *
 * The encryption key is the vault's 32-byte database key (hex-encoded),
 * obtained from `@cemp/secure-vault` (`getDatabaseKey()` /
 * `unwrapDatabaseKey()`) after unlock — the database cannot be opened without
 * the wrapped key (Phase 3 exit criterion). The key is passed to op-sqlite at
 * open time and never stored by this adapter.
 *
 * NOTE: op-sqlite must be built with its SQLCipher variant for
 * `encryptionKey` to take effect — see the app README runbook (verified at
 * first device build).
 */

import { open, type DB, type QueryResult, type Scalar } from "@op-engineering/op-sqlite";
import type { SqlParams, SqlRow, SqlRunResult, SqliteAdapter } from "@cemp/database";
import { AsyncMutex, DatabaseError } from "@cemp/database";

export interface OpSqlCipherOptions {
  /** Database file name inside the app's database directory. */
  readonly name: string;
  /** Hex-encoded 32-byte SQLCipher key from the vault. */
  readonly encryptionKeyHex: string;
}

/** op-sqlite has no bigint scalar: 64-bit ints travel as numbers (< 2^53 here). */
function toScalarParams(params: SqlParams): Scalar[] {
  return params.map((p): Scalar => (typeof p === "bigint" ? Number(p) : p));
}

function toRows(result: QueryResult): SqlRow[] {
  // Scalar (incl. ArrayBufferView) and SqlValue overlap on the wire shapes we
  // use; the cast is safe for our schema (INTEGER/TEXT/BLOB columns).
  return result.rows as unknown as SqlRow[];
}

/** Bind a statement result's rowsAffected/insertId to our run shape. */
function toRunResult(result: QueryResult): SqlRunResult {
  return {
    changes: result.rowsAffected,
    lastInsertRowid: Number(result.insertId ?? 0),
  };
}

export class OpSqlCipherAdapter implements SqliteAdapter {
  readonly #db: DB;
  readonly #txMutex = new AsyncMutex();
  /** Retained so destroy() can delete the file even after close(). */
  readonly #name: string;
  #closed = false;

  private constructor(db: DB, name: string) {
    this.#db = db;
    this.#name = name;
  }

  static open(options: OpSqlCipherOptions): OpSqlCipherAdapter {
    const db = open({ name: options.name, encryptionKey: options.encryptionKeyHex });
    return new OpSqlCipherAdapter(db, options.name);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DatabaseError("adapter-error", "the database connection is closed");
    }
  }

  async exec(sql: string): Promise<void> {
    this.#assertOpen();
    await this.#db.execute(sql);
  }

  async run(sql: string, params: SqlParams = []): Promise<SqlRunResult> {
    this.#assertOpen();
    return toRunResult(await this.#db.execute(sql, toScalarParams(params)));
  }

  async get(sql: string, params: SqlParams = []): Promise<SqlRow | undefined> {
    this.#assertOpen();
    const result = await this.#db.execute(sql, toScalarParams(params));
    const rows = toRows(result);
    return rows.length === 0 ? undefined : rows[0];
  }

  async all(sql: string, params: SqlParams = []): Promise<SqlRow[]> {
    this.#assertOpen();
    return toRows(await this.#db.execute(sql, toScalarParams(params)));
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    // Serialize concurrent callers on the mutex instead of racing on a
    // boolean flag: two callers evaluating the flag before either set it
    // could both issue BEGIN IMMEDIATE on the same connection (the bug that
    // surfaced as "cannot start a transaction within a transaction" once
    // the Phase 9 WorkManager tick and the Chats-screen sync could overlap).
    // Each queued call still gets its own independent BEGIN/COMMIT.
    return await this.#txMutex.runExclusive(async () => {
      await this.#db.execute("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        await this.#db.execute("COMMIT");
        return result;
      } catch (e) {
        await this.#db.execute("ROLLBACK");
        throw e;
      }
    });
  }

  /**
   * Close the connection, WAITING for any in-flight transaction first.
   *
   * Teardown takes the same mutex `transaction()` uses, so a close racing an
   * in-flight unit of work queues behind it instead of cutting it off. This is
   * the auto-lock case observed on device: the vault locked while a background
   * full sync was mid-transaction, the handle closed underneath it, and the
   * COMMIT failed with "the database connection is closed" — losing the work
   * and stranding a freshly discovered message part-way through its states.
   *
   * NOT reentrant (see {@link AsyncMutex}): `close()` must never be called
   * from inside a `transaction()` callback or it deadlocks. The only
   * production caller is AppContainer#closeDatabase, which runs at teardown
   * and holds no transaction.
   *
   * Behaviourally identical to the node adapter's `close()` (node.ts).
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

  /**
   * Close the handle and delete the database file (op-sqlite `DB#delete`).
   *
   * The file is encrypted with a key derived from the wallet seed, so it is
   * only readable by the wallet that created it. Wiping a wallet without
   * deleting this file strands an undecryptable database that the NEXT
   * wallet trips over — SQLCipher "hmac check failed for pgno=1", which the
   * app surfaced as a wrong-password error (device finding, 2026-07-29).
   *
   * Takes the same mutex as `close()` for the same reason, and is idempotent:
   * a destroy after a close still removes the file.
   */
  async destroy(): Promise<void> {
    await this.#txMutex.runExclusive(() => {
      // op-sqlite's delete() needs a LIVE handle — it closes and unlinks in
      // one step. Closing first and deleting after silently leaves the file,
      // which is precisely the orphan this method exists to remove, so the
      // ordering here is load-bearing rather than stylistic.
      if (this.#closed) {
        // Idempotent path: re-open purely as a means of deletion. Any key
        // works because deleting never reads a page (see AppContainer
        // #resetLocalData), and the file may legitimately be gone already.
        try {
          open({ name: this.#name, encryptionKey: "00".repeat(32) }).delete();
        } catch {
          // Already deleted, or never existed — the intended end state.
        }
        return Promise.resolve();
      }
      this.#db.delete();
      this.#closed = true;
      return Promise.resolve();
    });
  }
}
