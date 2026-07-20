import { describe, expect, it } from "vitest";
import { NodeSqliteAdapter } from "./node.js";

/**
 * Regression coverage for the Phase 9 concurrency bug: two SyncEngine
 * runs (the WorkManager tick and the Chats-screen on-focus sync) could
 * call transaction() concurrently on the same connection. The original
 * guard (`if (#inTransaction) return await fn();` with the flag set only
 * after `BEGIN IMMEDIATE`) let a second concurrent caller "join" the
 * first's transaction instead of queuing behind it — which silently
 * merges two unrelated units of work: a throw in one call's fn can leave
 * the other's already-executed writes uncommitted-or-rolled-back
 * together, and neither call actually waits for the other, so a caller
 * can start a fresh BEGIN IMMEDIATE while a "joined" caller is still
 * mid-write. transaction() must instead serialize callers on a queue
 * while giving each its own independent BEGIN/COMMIT.
 */
describe("NodeSqliteAdapter#transaction concurrency", () => {
  async function freshDb(): Promise<NodeSqliteAdapter> {
    const db = new NodeSqliteAdapter();
    await db.exec("CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
    return db;
  }

  it("runs several concurrent transaction() calls to completion with every write present", async () => {
    const db = await freshDb();
    try {
      const ids = [0, 1, 2, 3, 4, 5, 6, 7];
      await Promise.all(
        ids.map((id) =>
          db.transaction(async () => {
            // A real delay so the calls genuinely overlap in wall-clock
            // time rather than all completing within one microtask burst.
            await new Promise((resolve) => setTimeout(resolve, 1));
            await db.run("INSERT INTO counters (id, value) VALUES (?, ?)", [id, id * 10]);
          }),
        ),
      );
      const rows = await db.all("SELECT id, value FROM counters ORDER BY id");
      expect(rows).toHaveLength(ids.length);
      for (const id of ids) {
        expect(rows[id]).toEqual({ id, value: id * 10 });
      }
    } finally {
      await db.close();
    }
  });

  it("does not let one concurrent transaction's failure touch another's independent writes", async () => {
    const db = await freshDb();
    try {
      const results = await Promise.allSettled([
        db.transaction(async () => {
          await db.run("INSERT INTO counters (id, value) VALUES (?, ?)", [1, 100]);
          // Hold this transaction open past the second call's own work so
          // the two are genuinely concurrent, not accidentally serial.
          await new Promise((resolve) => setTimeout(resolve, 10));
        }),
        db.transaction(async () => {
          await db.run("INSERT INTO counters (id, value) VALUES (?, ?)", [2, 200]);
          throw new Error("boom");
        }),
      ]);
      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]?.status).toBe("rejected");

      const rows = await db.all("SELECT id FROM counters ORDER BY id");
      // The first (independent) transaction's write must survive; the
      // second's must be rolled back. If the two shared one BEGIN/COMMIT
      // — the pre-fix "join" behavior — either both rows would appear
      // (the failing call's write silently riding the survivor's commit)
      // or the survivor's row would vanish too.
      expect(rows.map((r) => r.id)).toEqual([1]);
    } finally {
      await db.close();
    }
  });

  it("rolls back a throwing transaction without wedging the queue for the next caller", async () => {
    const db = await freshDb();
    try {
      await expect(
        db.transaction(async () => {
          await db.run("INSERT INTO counters (id, value) VALUES (?, ?)", [1, 100]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await db.all("SELECT * FROM counters")).toHaveLength(0);

      // The queue must not be wedged: the next caller still runs and
      // commits normally.
      await db.transaction(async () => {
        await db.run("INSERT INTO counters (id, value) VALUES (?, ?)", [2, 200]);
      });
      expect(await db.all("SELECT id, value FROM counters")).toEqual([{ id: 2, value: 200 }]);
    } finally {
      await db.close();
    }
  });

  it("runs transactions one at a time, never overlapping", async () => {
    const db = await freshDb();
    try {
      let active = 0;
      let maxActive = 0;
      const completedOrder: number[] = [];
      await Promise.all(
        [0, 1, 2, 3].map((i) =>
          db.transaction(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            completedOrder.push(i);
          }),
        ),
      );
      expect(maxActive).toBe(1);
      expect(completedOrder).toHaveLength(4);
    } finally {
      await db.close();
    }
  });
});
