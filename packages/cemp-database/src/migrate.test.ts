import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseError } from "./errors.js";
import { currentSchemaVersion, MIGRATIONS, migrate } from "./migrate.js";
import { NodeSqliteAdapter } from "./node.js";
import { SCHEMA_VERSION, TABLE_NAMES } from "./schema.js";

/**
 * Migration runner tests (AGENTS.md: explicit versions, idempotent re-open).
 * Uses the Node adapter — this file is a Node test, never bundled for RN.
 */
describe("migrate", () => {
  it("applies v1 to a fresh database and records it", async () => {
    const db = new NodeSqliteAdapter();
    try {
      await migrate(db);
      expect(await currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
      // Every declared table exists and accepts a describe query.
      for (const table of TABLE_NAMES) {
        const rows = await db.all(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
          [table],
        );
        expect(rows, `table ${table}`).toHaveLength(1);
      }
      const bookkeeping = await db.all("SELECT * FROM cemp_schema_migrations");
      expect(bookkeeping).toHaveLength(MIGRATIONS.length);
    } finally {
      await db.close();
    }
  });

  it("is idempotent: re-running applies nothing (rule 5)", async () => {
    const db = new NodeSqliteAdapter();
    try {
      await migrate(db);
      await migrate(db);
      await migrate(db);
      const rows = await db.all("SELECT * FROM cemp_schema_migrations");
      expect(rows).toHaveLength(MIGRATIONS.length);
    } finally {
      await db.close();
    }
  });

  it("persists the schema across a close/reopen (restart)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cemp-db-migrate-"));
    const path = join(dir, "test.sqlite");
    try {
      const first = new NodeSqliteAdapter({ path });
      await migrate(first);
      await first.run("INSERT INTO settings (key, value) VALUES (?, ?)", ["theme", "dark"]);
      await first.close();

      const second = new NodeSqliteAdapter({ path });
      await migrate(second); // no-op on an up-to-date file
      expect(await currentSchemaVersion(second)).toBe(SCHEMA_VERSION);
      const row = await second.get("SELECT value FROM settings WHERE key = ?", ["theme"]);
      expect(row?.value).toBe("dark");
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("v7→v8: adds attachments.attachment_key; pre-existing rows get NULL", async () => {
    const db = new NodeSqliteAdapter();
    try {
      // Build a v7 database by hand (the on-device pre-upgrade state): apply
      // migrations 1..7 with their bookkeeping stamps, then let migrate()
      // take it from there.
      await db.exec(`CREATE TABLE IF NOT EXISTS cemp_schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      )`);
      for (const migration of MIGRATIONS.filter((m) => m.version <= 7)) {
        for (const statement of migration.statements) {
          await db.exec(statement);
        }
        await db.run(
          "INSERT INTO cemp_schema_migrations (version, description, applied_at_ms) VALUES (?, ?, ?)",
          [migration.version, migration.description, Date.now()],
        );
      }
      expect(await currentSchemaVersion(db)).toBe(7);
      // A pre-v8 attachment row (FK chain contact → conversation → message).
      await db.run(
        "INSERT INTO contacts (display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?)",
        ["alice", 1, 1],
      );
      await db.run(
        "INSERT INTO conversations (contact_id, created_at_ms, last_activity_at_ms) VALUES (?, ?, ?)",
        [1, 1, 1],
      );
      await db.run(
        "INSERT INTO messages (conversation_id, direction, state, body, logical_message_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [1, "incoming", "received", "", "lm-v8-upgrade", 1, 1],
      );
      await db.run(
        "INSERT INTO attachments (message_id, kind, byte_length, state, created_at_ms) VALUES (?, ?, ?, ?, ?)",
        [1, "image", 100, "pending", 1],
      );

      await migrate(db);

      expect(await currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
      const columns = await db.all("PRAGMA table_info(attachments)");
      expect(columns.map((c) => String(c.name))).toContain("attachment_key");
      // The pre-v8 row survives untouched: no key was ever derivable offline,
      // so the column stays NULL (the chain re-derivation fallback covers it).
      const row = await db.get("SELECT attachment_key FROM attachments WHERE message_id = ?", [1]);
      expect(row?.attachment_key).toBeNull();
      // And the column accepts key material going forward.
      await db.run("UPDATE attachments SET attachment_key = ? WHERE message_id = ?", [
        new Uint8Array(32).fill(7),
        1,
      ]);
      const keyed = await db.get(
        "SELECT attachment_key FROM attachments WHERE message_id = ?",
        [1],
      );
      expect(keyed?.attachment_key).toEqual(new Uint8Array(32).fill(7));
    } finally {
      await db.close();
    }
  });

  it("refuses a database stamped with an unknown (newer) version", async () => {
    const db = new NodeSqliteAdapter();
    try {
      await migrate(db);
      await db.run(
        "INSERT INTO cemp_schema_migrations (version, description, applied_at_ms) VALUES (?, ?, ?)",
        [99, "from the future", Date.now()],
      );
      await expect(migrate(db)).rejects.toMatchObject({ code: "migration-error" });
    } finally {
      await db.close();
    }
  });

  it("rolls a failed migration back atomically", async () => {
    const db = new NodeSqliteAdapter();
    try {
      await expect(
        db.transaction(async () => {
          await db.exec("CREATE TABLE txn_probe (id INTEGER PRIMARY KEY)");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const rows = await db.all("SELECT name FROM sqlite_master WHERE name = 'txn_probe'");
      expect(rows).toHaveLength(0); // rolled back
      // And the connection is still usable afterwards.
      await expect(
        db.exec("CREATE TABLE txn_ok (id INTEGER PRIMARY KEY)"),
      ).resolves.toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("adapter rejects use after close", async () => {
    const db = new NodeSqliteAdapter();
    await db.close();
    await expect(db.all("SELECT 1")).rejects.toMatchObject({
      code: "adapter-error",
    } satisfies Partial<DatabaseError>);
  });
});
