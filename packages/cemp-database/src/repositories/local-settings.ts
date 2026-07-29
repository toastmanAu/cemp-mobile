/**
 * Local key/value settings.
 *
 * Device-scoped preferences that are not part of the CEMP protocol and never
 * leave the device except where a feature explicitly sends them. Lives in the
 * encrypted database for consistency with all other user data, even where a
 * particular value is not itself secret.
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
    const row = await this.#db.get("SELECT value FROM local_settings WHERE key = ?", [key]);
    return row === undefined ? null : String(row.value);
  }

  async set(key: string, value: string): Promise<void> {
    await this.#db.run(
      `INSERT INTO local_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}
