/**
 * Outgoing-transaction repository (spec Phase 7 task 7; §11 table).
 *
 * The pre-broadcast journal (rule 6): every transaction we submit is recorded
 * here BEFORE broadcast, keyed by tx_hash (idempotent re-record) and by a
 * `purpose` string — the publisher uses `message:<logical_message_id>`, which
 * is what makes resume-after-crash possible without duplicating the logical
 * message (Phase 7 task 10).
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";

export interface OutgoingTransaction {
  readonly id: number;
  readonly txHash: string;
  readonly purpose: string;
  readonly state: string;
  readonly feeShannon: string | null;
  readonly submittedAtMs: number | null;
  readonly committedAtMs: number | null;
  readonly blockHash: string | null;
  /** Capacity moved by this tx (schema v3; null for non-reclaim txs). */
  readonly capacityShannon: string | null;
  /** The SIGNED wire transaction as JSON (schema v6) — rebroadcast material (review E1). */
  readonly txHex: string | null;
}

function rowToTx(row: SqlRow): OutgoingTransaction {
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(row.id),
    txHash: String(row.tx_hash),
    purpose: String(row.purpose),
    state: String(row.state),
    feeShannon: text(row.fee_shannon),
    submittedAtMs: num(row.submitted_at_ms),
    committedAtMs: num(row.committed_at_ms),
    blockHash: text(row.block_hash),
    capacityShannon: text(row.capacity_shannon),
    txHex: text(row.tx_hex),
  };
}

export class OutgoingTransactionRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  /** Record a transaction. Idempotent on tx_hash: re-recording returns the existing row. */
  async record(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string | undefined;
    submittedAtMs?: number | undefined;
    /** Capacity moved by this tx (schema v3: reclaim accounting, decimal shannon). */
    capacityShannon?: string | undefined;
    /** The signed wire transaction as JSON (schema v6) — stored BEFORE broadcast (rule 6). */
    txHex?: string | undefined;
  }): Promise<OutgoingTransaction> {
    await this.#db.run(
      `INSERT INTO outgoing_transactions (tx_hash, purpose, state, fee_shannon, submitted_at_ms, capacity_shannon, tx_hex)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        input.txHash,
        input.purpose,
        input.state,
        input.feeShannon ?? null,
        input.submittedAtMs ?? null,
        input.capacityShannon ?? null,
        input.txHex ?? null,
      ],
    );
    const row = await this.#db.get("SELECT * FROM outgoing_transactions WHERE tx_hash = ?", [
      input.txHash,
    ]);
    if (row === undefined) {
      throw new DatabaseError("adapter-error", "outgoing tx record did not produce a readable row");
    }
    return rowToTx(row);
  }

  async getByTxHash(txHash: string): Promise<OutgoingTransaction | undefined> {
    const row = await this.#db.get("SELECT * FROM outgoing_transactions WHERE tx_hash = ?", [
      txHash,
    ]);
    return row === undefined ? undefined : rowToTx(row);
  }

  /** The LATEST record for a purpose (a retry may have produced a newer tx). */
  async findLatestByPurpose(purpose: string): Promise<OutgoingTransaction | undefined> {
    const row = await this.#db.get(
      "SELECT * FROM outgoing_transactions WHERE purpose = ? ORDER BY id DESC LIMIT 1",
      [purpose],
    );
    return row === undefined ? undefined : rowToTx(row);
  }

  /** The LATEST record whose purpose starts with `prefix` (batch resume, Phase 8). */
  async findLatestByPurposePrefix(prefix: string): Promise<OutgoingTransaction | undefined> {
    const row = await this.#db.get(
      `SELECT * FROM outgoing_transactions WHERE purpose LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1`,
      [`${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
    );
    return row === undefined ? undefined : rowToTx(row);
  }

  /**
   * Transition a recorded transaction's state. Idempotent same-state writes
   * are no-ops; `committed` accepts the block hash + commit time.
   */
  async markState(
    txHash: string,
    state: string,
    patch: { committedAtMs?: number | undefined; blockHash?: string | undefined } = {},
  ): Promise<void> {
    const result = await this.#db.run(
      `UPDATE outgoing_transactions SET state = ?,
         committed_at_ms = COALESCE(?, committed_at_ms),
         block_hash = COALESCE(?, block_hash)
       WHERE tx_hash = ?`,
      [state, patch.committedAtMs ?? null, patch.blockHash ?? null, txHash],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `outgoing transaction ${txHash} is not recorded`);
    }
  }

  /**
   * Compare-and-swap state transition (review E5): returns the number of
   * rows changed — exactly one concurrent caller can win a
   * `submitted → committed` transition, so double-commit accounting is
   * impossible even without a lease.
   */
  async markStateIf(
    txHash: string,
    expectedFromState: string,
    state: string,
    patch: { committedAtMs?: number | undefined; blockHash?: string | undefined } = {},
  ): Promise<number> {
    const result = await this.#db.run(
      `UPDATE outgoing_transactions SET state = ?,
         committed_at_ms = COALESCE(?, committed_at_ms),
         block_hash = COALESCE(?, block_hash)
       WHERE tx_hash = ? AND state = ?`,
      [state, patch.committedAtMs ?? null, patch.blockHash ?? null, txHash, expectedFromState],
    );
    return result.changes;
  }

  async listByState(state: string, limit = 500): Promise<OutgoingTransaction[]> {
    const rows = await this.#db.all(
      "SELECT * FROM outgoing_transactions WHERE state = ? ORDER BY id LIMIT ?",
      [state, limit],
    );
    return rows.map(rowToTx);
  }
}
