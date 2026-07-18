/**
 * Rate-limit bucket persistence (spec Phase 11 task 9; schema v5).
 *
 * Token buckets keyed by scope string — `outgoing:<profileIdHex>` and
 * `incoming:<profileIdHex>` per contact, `outgoing:global` /
 * `incoming:global` fleet-wide. The {@link RateLimiter} (cemp-ckb) owns the
 * algorithm; this repository is the durable state so limits survive process
 * death and reboot (an attacker cannot reset a limit by waiting out the app).
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";

export interface RateLimitBucket {
  readonly bucket: string;
  readonly tokens: number;
  readonly updatedAtMs: number;
}

function rowToBucket(row: SqlRow): RateLimitBucket {
  return {
    bucket: String(row.bucket),
    tokens: Number(row.tokens),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class RateLimitRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  async get(bucket: string): Promise<RateLimitBucket | undefined> {
    const row = await this.#db.get("SELECT * FROM rate_limits WHERE bucket = ?", [bucket]);
    return row === undefined ? undefined : rowToBucket(row);
  }

  /** Upsert the bucket state (the limiter commits after every consume/refill). */
  async set(bucket: string, tokens: number, updatedAtMs: number): Promise<void> {
    await this.#db.run(
      `INSERT INTO rate_limits (bucket, tokens, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (bucket) DO UPDATE SET tokens = excluded.tokens, updated_at_ms = excluded.updated_at_ms`,
      [bucket, tokens, updatedAtMs],
    );
  }

  async delete(bucket: string): Promise<void> {
    await this.#db.run("DELETE FROM rate_limits WHERE bucket = ?", [bucket]);
  }
}
