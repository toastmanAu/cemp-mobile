import { describe, expect, it } from "vitest";
import {
  CHAT_CADENCE_MS,
  ForegroundSync,
  IDLE_CADENCE_MS,
  type TimerHandle,
} from "./foreground-sync.js";

/**
 * A hand-rolled timer harness rather than vitest's fake timers: the scheduler
 * interleaves timers with promises, and driving both explicitly makes the
 * ordering the assertions depend on visible in the test itself.
 */
function makeHarness() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let resolveSync: (() => void) | null = null;
  const syncCalls: number[] = [];
  let syncShouldReject = false;
  const errors: unknown[] = [];

  const deps = {
    sync: (): Promise<unknown> => {
      syncCalls.push(Date.now());
      if (syncShouldReject) {
        return Promise.reject(new Error("sweep failed"));
      }
      // Resolves only when the test says so, so "in flight" is controllable.
      return new Promise<void>((resolve) => {
        resolveSync = resolve;
      });
    },
    setTimer: (fn: () => void, ms: number): TimerHandle => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle: TimerHandle): void => {
      pending.delete(handle as number);
    },
    onError: (e: unknown): void => {
      errors.push(e);
    },
  };

  return {
    deps,
    errors,
    get syncCount(): number {
      return syncCalls.length;
    },
    /** The single armed timer, or undefined when none is pending. */
    armed(): { fn: () => void; ms: number } | undefined {
      const entries = [...pending.values()];
      expect(entries.length).toBeLessThanOrEqual(1);
      return entries[0];
    },
    /** Fire the armed timer. */
    fire(): void {
      const entries = [...pending.entries()];
      expect(entries).toHaveLength(1);
      const [id, entry] = entries[0]!;
      pending.delete(id);
      entry.fn();
    },
    /** Let the in-flight sweep finish, then flush microtasks. */
    async finishSync(): Promise<void> {
      expect(resolveSync).not.toBeNull();
      resolveSync?.();
      resolveSync = null;
      await Promise.resolve();
      await Promise.resolve();
    },
    async flush(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
    },
    failNext(): void {
      syncShouldReject = true;
    },
  };
}

describe("ForegroundSync", () => {
  it("sweeps immediately on start, then arms the cadence timer once it settles", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);

    sync.start(IDLE_CADENCE_MS);
    expect(h.syncCount).toBe(1);
    // Nothing armed while the sweep is still running — the completion owns it.
    expect(h.armed()).toBeUndefined();

    await h.finishSync();
    expect(h.armed()?.ms).toBe(IDLE_CADENCE_MS);
  });

  it("never overlaps sweeps: a resume mid-sweep does not start a second", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);

    sync.start(IDLE_CADENCE_MS);
    expect(h.syncCount).toBe(1);

    // Backgrounding and foregrounding again WHILE the first sweep is still in
    // flight is the one path that reaches `#run` re-entrantly — resume()'s own
    // early-return covers every other case, so this is what the in-flight
    // guard is actually for. Without it, two sweeps race the same cursors and
    // worker leases.
    sync.pause();
    sync.resume();
    await h.flush();
    expect(h.syncCount).toBe(1);

    // And the single in-flight sweep still arms exactly one timer on landing.
    await h.finishSync();
    expect(h.armed()?.ms).toBe(IDLE_CADENCE_MS);
  });

  it("applies a tightened cadence immediately instead of waiting out the long timer", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);

    sync.start(IDLE_CADENCE_MS);
    await h.finishSync();
    expect(h.armed()?.ms).toBe(IDLE_CADENCE_MS);

    // Opening a chat must not leave the user waiting out the remaining 30s.
    sync.setCadence(CHAT_CADENCE_MS);
    expect(h.armed()?.ms).toBe(CHAT_CADENCE_MS);
  });

  it("does not re-arm when the cadence loosens", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);

    sync.start(CHAT_CADENCE_MS);
    await h.finishSync();
    expect(h.armed()?.ms).toBe(CHAT_CADENCE_MS);

    // Leaving a chat: firing early is harmless, re-arming would delay further.
    sync.setCadence(IDLE_CADENCE_MS);
    expect(h.armed()?.ms).toBe(CHAT_CADENCE_MS);
    expect(sync.cadenceMs).toBe(IDLE_CADENCE_MS);

    // The NEXT arm uses the loosened cadence.
    h.fire();
    await h.finishSync();
    expect(h.armed()?.ms).toBe(IDLE_CADENCE_MS);
  });

  it("pauses on background and sweeps immediately on resume", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);

    sync.start(IDLE_CADENCE_MS);
    await h.finishSync();

    sync.pause();
    expect(h.armed()).toBeUndefined();
    expect(sync.running).toBe(false);

    sync.resume();
    expect(h.syncCount).toBe(2); // catch up at once, do not wait a full period
    expect(sync.running).toBe(true);
  });

  it("stops for good, including from a sweep that lands after the stop", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);

    sync.start(IDLE_CADENCE_MS);
    // Vault locks while the sweep is in flight.
    sync.stop();
    await h.finishSync();

    // The completing sweep must not resurrect the loop.
    expect(h.armed()).toBeUndefined();
    expect(h.syncCount).toBe(1);
  });

  it("runNow joins an in-flight sweep rather than starting a second", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);

    sync.start(IDLE_CADENCE_MS);
    expect(h.syncCount).toBe(1);

    // A screen focusing (or pull-to-refresh) mid-sweep must not double up.
    let settled = false;
    const joined = sync.runNow().then(() => {
      settled = true;
    });
    await h.flush();
    expect(h.syncCount).toBe(1);
    expect(settled).toBe(false); // still waiting on the in-flight sweep

    await h.finishSync();
    await joined;
    expect(settled).toBe(true); // resolves when fresh data has actually landed
  });

  it("runNow sweeps immediately when idle", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);

    sync.start(IDLE_CADENCE_MS);
    await h.finishSync();
    expect(h.syncCount).toBe(1);

    const pending = sync.runNow();
    expect(h.syncCount).toBe(2);
    await h.finishSync();
    await pending;
    expect(h.armed()?.ms).toBe(IDLE_CADENCE_MS);
  });

  it("keeps its cadence when a sweep fails, and reports the failure", async () => {
    const h = makeHarness();
    const sync = new ForegroundSync(h.deps);
    h.failNext();

    sync.start(IDLE_CADENCE_MS);
    await h.flush();

    expect(h.errors).toHaveLength(1);
    // A failed sweep must not kill autonomous sync — that is how a transient
    // RPC error would silently strand the app until the next app launch.
    expect(h.armed()?.ms).toBe(IDLE_CADENCE_MS);
  });
});
