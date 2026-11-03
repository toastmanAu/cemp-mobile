/**
 * Incoming cell dispositions (schema v11, ADR 0007 §5–§6).
 *
 * One row per discovered message source — a chain outpoint, or a LoRa
 * object keyed `lora:<hash>` with outpoint index -1 — recording what the
 * receive pipeline decided:
 *
 * - `ingested`: verified (or legacy-labelled) and stored. Re-scans re-run
 *   the pipeline for receipts (review E8) but are not charged to the
 *   pre-decryption budgets.
 * - `rejected`: terminal. Invalid signature, unbound profile, malformed
 *   cell. Never retried, never shown.
 * - `deferred`: the sender's key could not be resolved (RPC/indexer
 *   failure). The cell stays undisposed and is retried after an
 *   exponential backoff capped at {@link MAX_BACKOFF_MS}. LoRa objects keep
 *   their bytes here, because the gateway cursor has moved past them.
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { blobToBytes } from "../blob.js";

export type IncomingDisposition = "ingested" | "rejected" | "deferred";

export interface DispositionKey {
  /** Chain tx hash (0x…) or `lora:<hex>` for a chain-less source. */
  readonly txHash: string;
  /** Output index, or -1 for a chain-less source. */
  readonly outpointIndex: number;
}

export interface DispositionRecord {
  readonly key: DispositionKey;
  readonly disposition: IncomingDisposition;
  readonly attempts: number;
  readonly nextAttemptAtMs: number;
}

function rowToRecord(row: SqlRow): DispositionRecord {
  return {
    key: { txHash: String(row.source_key), outpointIndex: Number(row.outpoint_index) },
    disposition: String(row.disposition) as IncomingDisposition,
    attempts: Number(row.attempts),
    nextAttemptAtMs: Number(row.next_attempt_at_ms),
  };
}

export class IncomingDispositionRepository {
  /** First retry delay for a deferred cell. */
  static readonly BASE_BACKOFF_MS = 60_000;
  /** Backoff cap: a deferred cell is retried at least this often. */
  static readonly MAX_BACKOFF_MS = 6 * 3_600_000;

  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  async get(key: DispositionKey): Promise<DispositionRecord | undefined> {
    const row = await this.#db.get(
      "SELECT * FROM incoming_dispositions WHERE source_key = ? AND outpoint_index = ?",
      [key.txHash, key.outpointIndex],
    );
    return row === undefined ? undefined : rowToRecord(row);
  }

  async markIngested(key: DispositionKey, nowMs: number): Promise<void> {
    await this.#upsert(key, "ingested", 0, 0, null, nowMs);
  }

  async markRejected(key: DispositionKey, nowMs: number): Promise<void> {
    await this.#upsert(key, "rejected", 0, 0, null, nowMs);
  }

  /**
   * Record one more deferral: attempts + 1, next attempt after
   * BASE · 2^(attempts−1), capped at MAX. `cellData` is kept for chain-less
   * sources that cannot be re-read later.
   */
  async markDeferred(
    key: DispositionKey,
    nowMs: number,
    cellData: Uint8Array | null = null,
  ): Promise<DispositionRecord> {
    const existing = await this.get(key);
    const attempts = (existing?.disposition === "deferred" ? existing.attempts : 0) + 1;
    const exponent = Math.min(attempts - 1, 30);
    const delay = Math.min(
      IncomingDispositionRepository.BASE_BACKOFF_MS * 2 ** exponent,
      IncomingDispositionRepository.MAX_BACKOFF_MS,
    );
    await this.#upsert(key, "deferred", attempts, nowMs + delay, cellData, nowMs);
    return { key, disposition: "deferred", attempts, nextAttemptAtMs: nowMs + delay };
  }

  /** Deferred chain-less objects (with stored bytes) whose retry time has come. */
  async listDueDeferredWithData(
    nowMs: number,
    limit = 64,
  ): Promise<{ key: DispositionKey; cellData: Uint8Array }[]> {
    const rows = await this.#db.all(
      `SELECT source_key, outpoint_index, cell_data FROM incoming_dispositions
       WHERE disposition = 'deferred' AND cell_data IS NOT NULL AND next_attempt_at_ms <= ?
       ORDER BY next_attempt_at_ms LIMIT ?`,
      [nowMs, limit],
    );
    const out: { key: DispositionKey; cellData: Uint8Array }[] = [];
    for (const row of rows) {
      const data = blobToBytes(row.cell_data);
      if (data !== null) {
        out.push({
          key: { txHash: String(row.source_key), outpointIndex: Number(row.outpoint_index) },
          cellData: data,
        });
      }
    }
    return out;
  }

  async #upsert(
    key: DispositionKey,
    disposition: IncomingDisposition,
    attempts: number,
    nextAttemptAtMs: number,
    cellData: Uint8Array | null,
    nowMs: number,
  ): Promise<void> {
    await this.#db.run(
      `INSERT INTO incoming_dispositions
         (source_key, outpoint_index, disposition, attempts, next_attempt_at_ms, cell_data, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key, outpoint_index) DO UPDATE SET
         disposition = excluded.disposition, attempts = excluded.attempts,
         next_attempt_at_ms = excluded.next_attempt_at_ms,
         cell_data = CASE WHEN excluded.disposition = 'deferred'
           THEN COALESCE(excluded.cell_data, incoming_dispositions.cell_data) ELSE NULL END,
         updated_at_ms = excluded.updated_at_ms`,
      [key.txHash, key.outpointIndex, disposition, attempts, nextAttemptAtMs, cellData, nowMs],
    );
  }
}
