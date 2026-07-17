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
      expect(rows).toHaveLength(1);
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
      expect(await currentSchemaVersion(second)).toBe(1);
      const row = await second.get("SELECT value FROM settings WHERE key = ?", ["theme"]);
      expect(row?.value).toBe("dark");
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
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
