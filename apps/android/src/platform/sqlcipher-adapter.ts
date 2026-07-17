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
import { DatabaseError } from "@cemp/database";

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
  #closed = false;
  #inTransaction = false;

  private constructor(db: DB) {
    this.#db = db;
  }

  static open(options: OpSqlCipherOptions): OpSqlCipherAdapter {
    const db = open({ name: options.name, encryptionKey: options.encryptionKeyHex });
    return new OpSqlCipherAdapter(db);
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
    if (this.#inTransaction) {
      return await fn();
    }
    await this.#db.execute("BEGIN IMMEDIATE");
    this.#inTransaction = true;
    try {
      const result = await fn();
      await this.#db.execute("COMMIT");
      return result;
    } catch (e) {
      await this.#db.execute("ROLLBACK");
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
