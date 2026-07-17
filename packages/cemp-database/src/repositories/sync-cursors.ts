/**
 * Sync cursor repository (spec Phase 9 task 4; v1 `sync_cursors` table).
 *
 * One durable cursor per worker (`incoming-discovery`, `pending-transactions`,
 * `endpoint-rotation`, …). Cursors survive process death and reboot — a
 * worker always resumes from where it persisted, never from scratch and
 * never by re-reading everything (rule 5).
 */

import type { SqliteAdapter } from "../adapter.js";

export class SyncCursorRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  /** The persisted cursor for `worker`, or null when it never ran. */
  async get(worker: string): Promise<string | null> {
    const row = await this.#db.get("SELECT cursor FROM sync_cursors WHERE worker = ?", [worker]);
    return row === undefined || row.cursor === null || row.cursor === undefined
      ? null
      : String(row.cursor);
  }

  /** Persist the cursor (upsert; always forward-moving by caller convention). */
  async set(worker: string, cursor: string): Promise<void> {
    await this.#db.run(
      `INSERT INTO sync_cursors (worker, cursor, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (worker) DO UPDATE SET cursor = excluded.cursor, updated_at_ms = excluded.updated_at_ms`,
      [worker, cursor, Date.now()],
    );
  }

  async delete(worker: string): Promise<void> {
    await this.#db.run("DELETE FROM sync_cursors WHERE worker = ?", [worker]);
  }
}
