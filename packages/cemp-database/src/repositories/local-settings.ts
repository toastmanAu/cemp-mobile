/**
 * Local key/value settings.
 *
 * Device-scoped preferences that are not part of the CEMP protocol and never
 * leave the device except where a feature explicitly sends them. Lives in the
 * encrypted database for consistency with all other user data, even where a
 * particular value is not itself secret.
 *
 * Backed by the `settings` table, NOT a table named `local_settings` — this
 * is deliberate, not a naming bug. `settings (key TEXT PRIMARY KEY, value
 * TEXT NOT NULL)` has existed since schema v1 (spec §11) and was never read
 * or written by any application code path (it is used as a test fixture in
 * `migrate.test.ts`, key `"theme"`, against an isolated temp DB — no
 * production collision). Adding a second, identical `local_settings`
 * table would mean shipping a migration (append-only, so permanent) that
 * duplicates a table already sitting there unused. This repository adopts
 * the dormant v1 table instead: zero schema change, database stays at
 * SCHEMA_VERSION 8. The class is named `LocalSettingsRepository` (not
 * `SettingsRepository`) because it reflects what these values ARE — local,
 * device-only preferences — not the table's on-disk name.
 */

import type { SqliteAdapter } from "../adapter.js";

/** Display name used in the contact-card share caption. */
export const MY_DISPLAY_NAME_KEY = "my_display_name";

export class LocalSettingsRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  async get(key: string): Promise<string | null> {
    const row = await this.#db.get("SELECT value FROM settings WHERE key = ?", [key]);
    return row === undefined ? null : String(row.value);
  }

  async set(key: string, value: string): Promise<void> {
    await this.#db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}
