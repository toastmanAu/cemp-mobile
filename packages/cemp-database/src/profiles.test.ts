import { describe, expect, it } from "vitest";
import type { SqliteAdapter } from "./adapter.js";
import { currentSchemaVersion, MIGRATIONS, migrate } from "./migrate.js";
import { NodeSqliteAdapter } from "./node.js";
import { ContactRepository } from "./repositories/contacts.js";
import { ProfileRepository } from "./repositories/profiles.js";

/**
 * Profile lineage repository + the schema v1 → v2 upgrade path (Phase 5).
 */
async function makeDb(): Promise<SqliteAdapter> {
  const db = new NodeSqliteAdapter();
  await migrate(db);
  return db;
}

/** profiles.account_id references accounts, which references wallets. */
async function makeAccount(db: SqliteAdapter): Promise<number> {
  await db.run("INSERT INTO wallets (name, created_at_ms) VALUES (?, ?)", ["w", 1]);
  const result = await db.run(
    "INSERT INTO accounts (wallet_id, label, network, created_at_ms) VALUES (1, ?, ?, ?)",
    ["main", "ckb_testnet", 1],
  );
  return result.lastInsertRowid;
}

describe("ProfileRepository", () => {
  it("create → active lookup → rotate → lineage walk (root → tip)", async () => {
    const db = await makeDb();
    try {
      const accountId = await makeAccount(db);
      const profiles = new ProfileRepository(db);

      const root = await profiles.create({
        accountId,
        profileIdHex: "0xroot",
        typeIdHex: "0xroot",
      });
      expect((await profiles.getActiveByAccount(accountId))?.profileIdHex).toBe("0xroot");

      const second = await profiles.rotate("0xroot", {
        profileIdHex: "0xsecond",
        typeIdHex: "0xsecond",
      });
      expect(second.previousProfileIdHex).toBe("0xroot");
      expect((await profiles.getByProfileId("0xroot"))?.state).toBe("rotated");
      expect((await profiles.getActiveByAccount(accountId))?.profileIdHex).toBe("0xsecond");

      await profiles.rotate("0xsecond", { profileIdHex: "0xthird" });
      const lineage = await profiles.getLineage("0xthird");
      expect(lineage.map((p) => p.profileIdHex)).toEqual(["0xroot", "0xsecond", "0xthird"]);
      expect(lineage[0]!.previousProfileIdHex).toBeNull();
      expect(root.id).toBe(lineage[0]!.id);

      // Only an ACTIVE profile rotates; rotating the retired root refuses.
      await expect(profiles.rotate("0xroot", { profileIdHex: "0xfourth" })).rejects.toMatchObject({
        code: "illegal-state-transition",
      });
      await expect(
        profiles.rotate("0xmissing", { profileIdHex: "0xfourth" }),
      ).rejects.toMatchObject({
        code: "not-found",
      });

      await profiles.markRevoked("0xthird");
      expect((await profiles.getByProfileId("0xthird"))?.state).toBe("revoked");
    } finally {
      await db.close();
    }
  });

  it("rotation is atomic: a conflicting successor leaves the old profile active", async () => {
    const db = await makeDb();
    try {
      const accountId = await makeAccount(db);
      const profiles = new ProfileRepository(db);
      await profiles.create({ accountId, profileIdHex: "0xa" });
      await profiles.create({ accountId, profileIdHex: "0xb" });
      // Successor id 0xb already exists → the insert fails and the rotation
      // must roll back, leaving 0xa active.
      await expect(profiles.rotate("0xa", { profileIdHex: "0xb" })).rejects.toMatchObject({
        code: "constraint-violation",
      });
      expect((await profiles.getByProfileId("0xa"))?.state).toBe("active");
    } finally {
      await db.close();
    }
  });
});

describe("schema v1 → v2 upgrade", () => {
  it("upgrades an existing v1 database and preserves rows", async () => {
    const db = new NodeSqliteAdapter();
    try {
      // Simulate a v1 database: apply ONLY the v1 statements and stamp v1.
      const v1 = MIGRATIONS.find((m) => m.version === 1)!;
      await db.exec(`CREATE TABLE IF NOT EXISTS cemp_schema_migrations (
        version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at_ms INTEGER NOT NULL)`);
      await db.transaction(async () => {
        for (const statement of v1.statements) {
          await db.exec(statement);
        }
        await db.run(
          "INSERT INTO cemp_schema_migrations (version, description, applied_at_ms) VALUES (?, ?, ?)",
          [1, v1.description, 1],
        );
      });
      expect(await currentSchemaVersion(db)).toBe(1);
      // Pre-upgrade data.
      await db.run(
        "INSERT INTO contacts (display_name, notes, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
        ["legacy", "pre-v2", 1, 1],
      );

      await migrate(db);
      expect(await currentSchemaVersion(db)).toBe(2);

      // The legacy row survived and gained the (null) security columns.
      const contacts = new ContactRepository(db);
      const legacy = (await contacts.list())[0]!;
      expect(legacy.displayName).toBe("legacy");
      const security = await contacts.getProfileSecurity(legacy.id);
      expect(security?.fingerprint).toBeNull();

      // And the v2 material round-trips.
      await contacts.setProfileSecurity(legacy.id, {
        profileTypeIdHex: "0x" + "ab".repeat(32),
        mlDsaPublicKey: new Uint8Array([1, 2]),
        mlKemPublicKey: new Uint8Array([3, 4]),
        fingerprint: "AC2A-3EB2-3695-BFE8-6997-B339-E98F-5ED2",
        trustVerdict: "trusted",
      });
      const updated = await contacts.getProfileSecurity(legacy.id);
      expect(updated?.profileTypeIdHex).toBe("0x" + "ab".repeat(32));
      expect(updated?.mlDsaPublicKey).toEqual(new Uint8Array([1, 2]));
      expect(updated?.mlKemPublicKey).toEqual(new Uint8Array([3, 4]));
      expect(updated?.fingerprint).toBe("AC2A-3EB2-3695-BFE8-6997-B339-E98F-5ED2");
      expect(updated?.trustVerdict).toBe("trusted");
    } finally {
      await db.close();
    }
  });
});
