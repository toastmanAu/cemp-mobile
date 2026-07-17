import { describe, expect, it } from "vitest";
import { NodeSqliteAdapter } from "@cemp/database/node";
import { SyncCursorRepository, WorkerLeaseRepository, migrate } from "@cemp/database";
import { InMemoryScheduler, SyncEngine, type WorkerSpec } from "./engine.js";
import { BackoffPolicy } from "./retry.js";

/**
 * Engine mechanics: scheduling, worker leases, persisted backoff attempts.
 */
async function makeEngineDeps(workers: WorkerSpec[], engineId = "engine-1") {
  const db = new NodeSqliteAdapter();
  await migrate(db);
  const leases = new WorkerLeaseRepository(db);
  const cursors = new SyncCursorRepository(db);
  const scheduler = new InMemoryScheduler();
  const backoff = new BackoffPolicy({
    baseMs: 1000,
    multiplier: 2,
    capMs: 8000,
    jitter: 0,
    random: () => 0.5,
  });
  const engine = new SyncEngine({ scheduler, leases, cursors, workers, backoff, engineId });
  return { db, leases, cursors, scheduler, backoff, engine };
}

describe("BackoffPolicy (task 3)", () => {
  it("doubles to the cap and applies jitter bounds", () => {
    const noJitter = new BackoffPolicy({ baseMs: 1000, multiplier: 2, capMs: 8000, jitter: 0 });
    expect(noJitter.delay(0)).toBe(1000);
    expect(noJitter.delay(1)).toBe(2000);
    expect(noJitter.delay(2)).toBe(4000);
    expect(noJitter.delay(3)).toBe(8000);
    expect(noJitter.delay(9)).toBe(8000); // capped

    const jittered = new BackoffPolicy({
      baseMs: 1000,
      multiplier: 2,
      capMs: 8000,
      jitter: 0.25,
      random: () => 0,
    });
    expect(jittered.delay(1)).toBe(1500); // nominal 2000 − 25%
    const jitteredHigh = new BackoffPolicy({
      baseMs: 1000,
      multiplier: 2,
      capMs: 8000,
      jitter: 0.25,
      random: () => 0.999,
    });
    expect(jitteredHigh.delay(1)).toBeGreaterThan(2000);
    expect(jitteredHigh.delay(1)).toBeLessThanOrEqual(2500);
    expect(() => noJitter.delay(-1)).toThrow();
  });
});

describe("SyncEngine", () => {
  const workerOk: WorkerSpec = {
    id: "ok",
    intervalMs: 60_000,
    requiresNetwork: true,
    run: () => Promise.resolve(),
  };

  it("start() registers every worker periodically; runWorker success clears retries", async () => {
    const { db, engine, scheduler, cursors } = await makeEngineDeps([workerOk]);
    try {
      engine.start();
      expect(scheduler.periodic.get("ok")).toEqual({ intervalMs: 60_000, requiresNetwork: true });
      await cursors.set("retry:ok", "3");
      expect(await engine.runWorker("ok")).toBe("success");
      expect(await cursors.get("retry:ok")).toBeNull();
      expect(scheduler.oneShots.has("ok:retry")).toBe(false);
      expect(await engine.runWorker("nope")).toBe("unknown-worker");
    } finally {
      await db.close();
    }
  });

  it("a failing worker persists the attempt and schedules a backoff one-shot", async () => {
    const failing: WorkerSpec = {
      id: "flaky",
      intervalMs: 60_000,
      requiresNetwork: true,
      run: () => Promise.reject(new Error("boom")),
    };
    const { db, engine, scheduler, cursors } = await makeEngineDeps([failing]);
    try {
      expect(await engine.runWorker("flaky")).toBe("retry");
      expect(scheduler.oneShots.get("flaky:retry")).toBe(1000); // attempt 0 → base
      expect(await cursors.get("retry:flaky")).toBe("1");
      // Second failure: attempt 1 → 2000 (attempt counter survives "reboot"
      // because it is persisted, not in-memory).
      expect(await engine.runWorker("flaky")).toBe("retry");
      expect(scheduler.oneShots.get("flaky:retry")).toBe(2000);
      expect(await cursors.get("retry:flaky")).toBe("2");
    } finally {
      await db.close();
    }
  });

  it("a rival live lease skips the run (task 9/10)", async () => {
    let ran = 0;
    const guarded: WorkerSpec = {
      id: "guarded",
      intervalMs: 60_000,
      requiresNetwork: false,
      run: () => {
        ran += 1;
        return Promise.resolve();
      },
    };
    const first = await makeEngineDeps([guarded], "engine-A");
    const second = await makeEngineDeps([guarded], "engine-B");
    try {
      // Engine A holds the worker lease with a long TTL…
      const lease = await first.leases.acquire("worker:guarded", "engine-A", 60_000);
      expect(lease).not.toBeNull();
      // …the SAME database is shared: engine B over that DB is skipped.
      const engineB = new SyncEngine({
        scheduler: new InMemoryScheduler(),
        leases: first.leases,
        cursors: first.cursors,
        workers: [guarded],
        backoff: first.backoff,
        engineId: "engine-B",
      });
      expect(await engineB.runWorker("guarded")).toBe("skipped-lease");
      expect(ran).toBe(0);
      // After release it runs.
      await first.leases.release("worker:guarded", "engine-A");
      expect(await engineB.runWorker("guarded")).toBe("success");
      expect(ran).toBe(1);
      void second;
    } finally {
      await first.db.close();
      await second.db.close();
    }
  });

  it("runAllNow drains workers in registration order (foreground catch-up, task 5)", async () => {
    const order: string[] = [];
    const make = (id: string): WorkerSpec => ({
      id,
      intervalMs: 60_000,
      requiresNetwork: true,
      run: () => {
        order.push(id);
        return Promise.resolve();
      },
    });
    const { db, engine } = await makeEngineDeps([make("a"), make("b"), make("c")]);
    try {
      const results = await engine.runAllNow();
      expect(order).toEqual(["a", "b", "c"]);
      expect(results).toEqual({ a: "success", b: "success", c: "success" });
    } finally {
      await db.close();
    }
  });
});
