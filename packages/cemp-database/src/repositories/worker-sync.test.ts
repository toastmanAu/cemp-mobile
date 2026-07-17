import { describe, expect, it } from "vitest";
import { NodeSqliteAdapter } from "../node.js";
import { migrate } from "../migrate.js";
import { SyncCursorRepository } from "./sync-cursors.js";
import { WorkerLeaseRepository } from "./worker-leases.js";

/** Worker leases + sync cursors (Phase 9 tasks 4, 9, 10). */
describe("WorkerLeaseRepository", () => {
  it("acquire/rival/steal/release semantics", async () => {
    const db = new NodeSqliteAdapter();
    await migrate(db);
    try {
      const leases = new WorkerLeaseRepository(db);
      const now = 10_000;

      const a = await leases.acquire("reclaim:batch", "engine-A", 1000, now);
      expect(a?.owner).toBe("engine-A");
      // A live rival is rejected.
      expect(await leases.acquire("reclaim:batch", "engine-B", 1000, now + 500)).toBeNull();
      // Same owner re-acquires (refresh).
      expect((await leases.acquire("reclaim:batch", "engine-A", 1000, now + 600))?.owner).toBe(
        "engine-A",
      );
      // After expiry, B steals it.
      const stolen = await leases.acquire("reclaim:batch", "engine-B", 1000, now + 2000);
      expect(stolen?.owner).toBe("engine-B");
      // Release only works for the holder.
      await leases.release("reclaim:batch", "engine-A");
      expect((await leases.get("reclaim:batch"))?.owner).toBe("engine-B");
      await leases.release("reclaim:batch", "engine-B");
      expect(await leases.get("reclaim:batch")).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("pruneExpired deletes only expired leases", async () => {
    const db = new NodeSqliteAdapter();
    await migrate(db);
    try {
      const leases = new WorkerLeaseRepository(db);
      await leases.acquire("old", "e", 100, 1000);
      await leases.acquire("fresh", "e", 10_000, 1000);
      expect(await leases.pruneExpired(5000)).toBe(1);
      expect(await leases.get("old")).toBeUndefined();
      expect(await leases.get("fresh")).toBeDefined();
    } finally {
      await db.close();
    }
  });
});

describe("SyncCursorRepository", () => {
  it("persists and overwrites cursors per worker (task 4)", async () => {
    const db = new NodeSqliteAdapter();
    await migrate(db);
    try {
      const cursors = new SyncCursorRepository(db);
      expect(await cursors.get("incoming-discovery")).toBeNull();
      await cursors.set("incoming-discovery", "0xabc");
      await cursors.set("incoming-discovery", "0xdef");
      expect(await cursors.get("incoming-discovery")).toBe("0xdef");
      await cursors.delete("incoming-discovery");
      expect(await cursors.get("incoming-discovery")).toBeNull();
    } finally {
      await db.close();
    }
  });
});
