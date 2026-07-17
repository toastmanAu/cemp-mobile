/**
 * Worker lease repository (spec Phase 9 tasks 9–10).
 *
 * A lease is a database row keyed by an arbitrary resource string —
 * `outpoint:<txHash>:<index>` for outpoint-processing workers, `reclaim:batch`
 * for the reclaim job. Acquisition is atomic (INSERT … ON CONFLICT DO
 * NOTHING, then inspect), so two racing engines can never both hold the same
 * lease; a crashed owner's lease expires and is stolen after its TTL. This is
 * what makes "duplicate workers do not produce duplicate responses or reclaim
 * transactions" hold even under concurrent scheduling.
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";

export interface WorkerLease {
  readonly resource: string;
  readonly owner: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

function rowToLease(row: SqlRow): WorkerLease {
  return {
    resource: String(row.resource),
    owner: String(row.owner),
    acquiredAtMs: Number(row.acquired_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

export class WorkerLeaseRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  /**
   * Try to acquire `resource` for `owner` until `nowMs + ttlMs`. Returns the
   * held lease, or null when another owner holds an UNEXPIRED lease. An
   * expired lease is stolen (the row is replaced atomically inside one
   * transaction).
   */
  async acquire(
    resource: string,
    owner: string,
    ttlMs: number,
    nowMs = Date.now(),
  ): Promise<WorkerLease | null> {
    return await this.#db.transaction(async () => {
      const inserted = await this.#db.run(
        `INSERT INTO worker_leases (resource, owner, acquired_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (resource) DO NOTHING`,
        [resource, owner, nowMs, nowMs + ttlMs],
      );
      if (inserted.changes === 0) {
        const existing = await this.#db.get("SELECT * FROM worker_leases WHERE resource = ?", [
          resource,
        ]);
        if (existing === undefined) {
          throw new DatabaseError("adapter-error", "lease row vanished during acquire");
        }
        const lease = rowToLease(existing);
        if (lease.owner === owner) {
          // Re-entrant acquire by the same owner: refresh the TTL.
          await this.#db.run("UPDATE worker_leases SET expires_at_ms = ? WHERE resource = ?", [
            nowMs + ttlMs,
            resource,
          ]);
          return { ...lease, expiresAtMs: nowMs + ttlMs };
        }
        if (lease.expiresAtMs > nowMs) {
          return null; // another live owner holds it
        }
        // Expired: steal.
        await this.#db.run(
          "UPDATE worker_leases SET owner = ?, acquired_at_ms = ?, expires_at_ms = ? WHERE resource = ?",
          [owner, nowMs, nowMs + ttlMs, resource],
        );
        return { resource, owner, acquiredAtMs: nowMs, expiresAtMs: nowMs + ttlMs };
      }
      return { resource, owner, acquiredAtMs: nowMs, expiresAtMs: nowMs + ttlMs };
    });
  }

  /** Release the lease — only when `owner` still holds it (never another's). */
  async release(resource: string, owner: string): Promise<void> {
    await this.#db.run("DELETE FROM worker_leases WHERE resource = ? AND owner = ?", [
      resource,
      owner,
    ]);
  }

  /** Current holder of `resource`, if any (unexpired or not). */
  async get(resource: string): Promise<WorkerLease | undefined> {
    const row = await this.#db.get("SELECT * FROM worker_leases WHERE resource = ?", [resource]);
    return row === undefined ? undefined : rowToLease(row);
  }

  /** Delete all expired leases (maintenance worker). Returns deleted count. */
  async pruneExpired(nowMs = Date.now()): Promise<number> {
    const result = await this.#db.run("DELETE FROM worker_leases WHERE expires_at_ms <= ?", [
      nowMs,
    ]);
    return result.changes;
  }
}
