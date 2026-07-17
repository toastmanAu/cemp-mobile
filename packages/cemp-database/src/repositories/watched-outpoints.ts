/**
 * Watched-outpoint repository (spec Phase 6 task 6).
 *
 * The spent-detection backbone: every outpoint whose spend matters to the
 * user (own message cells awaiting ack, cells eligible for reclaim) is
 * registered here, and the Phase 9 watched-outpoint worker flips them to
 * `spent` with the spending tx hash. Rule 8: a spent/reclaimed outpoint NEVER
 * deletes the associated message history — this repository only tracks the
 * on-chain cell, never the conversation row.
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";

export type WatchedOutpointStatus = "watching" | "spent";

export interface WatchedOutpoint {
  readonly id: number;
  readonly txHash: string;
  readonly outpointIndex: number;
  readonly purpose: string;
  readonly status: WatchedOutpointStatus;
  readonly spentByTxHash: string | null;
  readonly reclaimGroupId: number | null;
  readonly createdAtMs: number;
  readonly spentAtMs: number | null;
}

function rowToWatched(row: SqlRow): WatchedOutpoint {
  return {
    id: Number(row.id),
    txHash: String(row.tx_hash),
    outpointIndex: Number(row.outpoint_index),
    purpose: String(row.purpose),
    status: String(row.status) as WatchedOutpointStatus,
    spentByTxHash:
      row.spent_by_tx_hash === null || row.spent_by_tx_hash === undefined
        ? null
        : String(row.spent_by_tx_hash),
    reclaimGroupId:
      row.reclaim_group_id === null || row.reclaim_group_id === undefined
        ? null
        : Number(row.reclaim_group_id),
    createdAtMs: Number(row.created_at_ms),
    spentAtMs:
      row.spent_at_ms === null || row.spent_at_ms === undefined ? null : Number(row.spent_at_ms),
  };
}

export class WatchedOutpointRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  /**
   * Register an outpoint for watching. Idempotent on (tx_hash, index): a
   * duplicate registration returns the existing row unchanged (rule 5).
   */
  async register(input: {
    txHash: string;
    outpointIndex: number;
    purpose: string;
    reclaimGroupId?: number;
  }): Promise<WatchedOutpoint> {
    const now = Date.now();
    const result = await this.#db.run(
      `INSERT INTO watched_outpoints (tx_hash, outpoint_index, purpose, status, reclaim_group_id, created_at_ms)
       VALUES (?, ?, ?, 'watching', ?, ?)
       ON CONFLICT (tx_hash, outpoint_index) DO NOTHING`,
      [input.txHash, input.outpointIndex, input.purpose, input.reclaimGroupId ?? null, now],
    );
    void result;
    const row = await this.#db.get(
      "SELECT * FROM watched_outpoints WHERE tx_hash = ? AND outpoint_index = ?",
      [input.txHash, input.outpointIndex],
    );
    if (row === undefined) {
      throw new DatabaseError("adapter-error", "outpoint register did not produce a readable row");
    }
    return rowToWatched(row);
  }

  /**
   * Mark an outpoint spent. Idempotent: re-marking with the same spending tx
   * is a no-op; a CONFLICTING spending tx indicates an indexer/view
   * inconsistency and throws.
   */
  async markSpent(
    txHash: string,
    outpointIndex: number,
    spentByTxHash: string,
  ): Promise<WatchedOutpoint> {
    return await this.#db.transaction(async () => {
      const existing = await this.#db.get(
        "SELECT * FROM watched_outpoints WHERE tx_hash = ? AND outpoint_index = ?",
        [txHash, outpointIndex],
      );
      if (existing === undefined) {
        throw new DatabaseError(
          "not-found",
          `outpoint ${txHash}:${String(outpointIndex)} is not watched`,
        );
      }
      const current = rowToWatched(existing);
      if (current.status === "spent") {
        if (current.spentByTxHash === spentByTxHash) {
          return current;
        }
        throw new DatabaseError(
          "constraint-violation",
          `outpoint already recorded spent by a different transaction`,
        );
      }
      await this.#db.run(
        "UPDATE watched_outpoints SET status = 'spent', spent_by_tx_hash = ?, spent_at_ms = ? WHERE tx_hash = ? AND outpoint_index = ?",
        [spentByTxHash, Date.now(), txHash, outpointIndex],
      );
      const updated = await this.#db.get(
        "SELECT * FROM watched_outpoints WHERE tx_hash = ? AND outpoint_index = ?",
        [txHash, outpointIndex],
      );
      if (updated === undefined) {
        throw new DatabaseError("adapter-error", "outpoint vanished during mark-spent");
      }
      return rowToWatched(updated);
    });
  }

  /** Active watches — what the Phase 9 worker polls. */
  async listActive(): Promise<WatchedOutpoint[]> {
    const rows = await this.#db.all(
      "SELECT * FROM watched_outpoints WHERE status = 'watching' ORDER BY id",
    );
    return rows.map(rowToWatched);
  }

  /** Everything in one reclaim group (reclaim batch building). */
  async listByReclaimGroup(reclaimGroupId: number): Promise<WatchedOutpoint[]> {
    const rows = await this.#db.all(
      "SELECT * FROM watched_outpoints WHERE reclaim_group_id = ? ORDER BY id",
      [reclaimGroupId],
    );
    return rows.map(rowToWatched);
  }

  /**
   * Delete spent watch records (Phase 8 task 11): watched outpoints are
   * TEMPORARY chain data — once the spend is recorded and the related message
   * transitioned, the record has no further purpose. Chat history lives in
   * the messages table and is never touched here (rule 8). Returns the number
   * of deleted rows.
   */
  async pruneSpent(): Promise<number> {
    const result = await this.#db.run("DELETE FROM watched_outpoints WHERE status = 'spent'");
    return result.changes;
  }
}
