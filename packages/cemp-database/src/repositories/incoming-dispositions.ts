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
 *   failure, or no live profile yet). The cell stays undisposed and is
 *   retried after an exponential backoff capped at {@link MAX_BACKOFF_MS}.
 *   LoRa objects keep their bytes here, because the gateway cursor has
 *   moved past them.
 *
 * Deferral is bounded only by DEFINITE answers: a deferral marked
 * `notFound` (the node answered "no such profile") counts toward
 * {@link MAX_NOT_FOUND_DEFERRALS}, after which the cell is rejected for
 * good. Transport failures never count, so an outage on our side cannot
 * discard a genuine message; without the limit, cells naming fabricated
 * profiles would be re-queried forever.
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

export interface DeferralOptions {
  /** The node answered that the sender's profile does not exist (yet). */
  readonly notFound?: boolean;
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
  /**
   * Definite not-found answers before a deferred cell is rejected. With the
   * backoff above, the 12th answer comes at least ~20 hours after the first:
   * far beyond any indexer lag on a freshly published profile.
   */
  static readonly MAX_NOT_FOUND_DEFERRALS = 12;

  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  async get(key: DispositionKey): Promise<DispositionRecord | undefined> {
    const row = await this.#getRow(key);
    return row === undefined ? undefined : rowToRecord(row);
  }

  async #getRow(key: DispositionKey): Promise<SqlRow | undefined> {
    return this.#db.get(
      "SELECT * FROM incoming_dispositions WHERE source_key = ? AND outpoint_index = ?",
      [key.txHash, key.outpointIndex],
    );
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
   * sources that cannot be re-read later. The
   * {@link MAX_NOT_FOUND_DEFERRALS}th `notFound` deferral rejects instead,
   * and the returned record says so.
   */
  async markDeferred(
    key: DispositionKey,
    nowMs: number,
    cellData: Uint8Array | null = null,
    options: DeferralOptions = {},
  ): Promise<DispositionRecord> {
    const existing = await this.#getRow(key);
    const wasDeferred = existing !== undefined && String(existing.disposition) === "deferred";
    const notFoundCount =
      (wasDeferred ? Number(existing.not_found_count) : 0) + (options.notFound === true ? 1 : 0);
    if (notFoundCount >= IncomingDispositionRepository.MAX_NOT_FOUND_DEFERRALS) {
      await this.markRejected(key, nowMs);
      return { key, disposition: "rejected", attempts: 0, nextAttemptAtMs: 0 };
    }
    const attempts = (wasDeferred ? Number(existing.attempts) : 0) + 1;
    const exponent = Math.min(attempts - 1, 30);
    const delay = Math.min(
      IncomingDispositionRepository.BASE_BACKOFF_MS * 2 ** exponent,
      IncomingDispositionRepository.MAX_BACKOFF_MS,
    );
    await this.#upsert(key, "deferred", attempts, nowMs + delay, cellData, nowMs, notFoundCount);
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
    notFoundCount = 0,
  ): Promise<void> {
    await this.#db.run(
      `INSERT INTO incoming_dispositions
         (source_key, outpoint_index, disposition, attempts, next_attempt_at_ms, cell_data,
          updated_at_ms, not_found_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key, outpoint_index) DO UPDATE SET
         disposition = excluded.disposition, attempts = excluded.attempts,
         next_attempt_at_ms = excluded.next_attempt_at_ms,
         not_found_count = excluded.not_found_count,
         cell_data = CASE WHEN excluded.disposition = 'deferred'
           THEN COALESCE(excluded.cell_data, incoming_dispositions.cell_data) ELSE NULL END,
         updated_at_ms = excluded.updated_at_ms`,
      [
        key.txHash,
        key.outpointIndex,
        disposition,
        attempts,
        nextAttemptAtMs,
        cellData,
        nowMs,
        notFoundCount,
      ],
    );
  }
}
