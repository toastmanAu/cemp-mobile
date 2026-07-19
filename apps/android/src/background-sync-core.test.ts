import { describe, expect, it } from "vitest";
import { runBackgroundSync, type BackgroundSyncDeps } from "./background-sync-core";
import type { TagCache } from "./platform/route-tag-cache-codec";

function makeDeps(overrides: Partial<BackgroundSyncDeps> = {}): {
  deps: BackgroundSyncDeps;
  calls: string[];
  written: TagCache[];
  notified: number[];
} {
  const calls: string[] = [];
  const written: TagCache[] = [];
  const notified: number[] = [];
  const deps: BackgroundSyncDeps = {
    isVaultUnlocked: () => false,
    runFullSync: () => {
      calls.push("runFullSync");
      return Promise.resolve();
    },
    refreshTagCache: () => {
      calls.push("refreshTagCache");
      return Promise.resolve();
    },
    readTagCache: () => Promise.resolve(undefined),
    writeTagCache: (cache) => {
      written.push(cache);
      return Promise.resolve();
    },
    listOutpointsForTag: () => Promise.resolve([]),
    notify: (count) => {
      notified.push(count);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, calls, written, notified };
}

describe("background sync branch", () => {
  it("runs the full engine and refreshes tags when unlocked", async () => {
    const { deps, calls } = makeDeps({ isVaultUnlocked: () => true });
    expect(await runBackgroundSync(deps)).toBe("full");
    expect(calls).toEqual(["runFullSync", "refreshTagCache"]);
  });

  it("does nothing when locked and no cache exists", async () => {
    const { deps, calls, notified } = makeDeps();
    expect(await runBackgroundSync(deps)).toBe("idle");
    expect(calls).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("notifies once for the count of unseen outpoints", async () => {
    const { deps, calls, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa", "bb"], lastSeen: ["x:0"] }),
      listOutpointsForTag: (tag) => Promise.resolve(tag === "aa" ? ["x:0", "y:0"] : ["z:0"]),
    });
    expect(await runBackgroundSync(deps)).toBe("notified");
    expect(notified).toEqual([2]); // y:0 and z:0 are new; x:0 was seen
    // NEVER runs the engine while locked.
    expect(calls).toEqual([]);
    expect(written).toEqual([{ tags: ["aa", "bb"], lastSeen: ["x:0", "y:0", "z:0"] }]);
  });

  it("stays quiet and still records the sighting when nothing is new", async () => {
    const { deps, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa"], lastSeen: ["x:0"] }),
      listOutpointsForTag: () => Promise.resolve(["x:0"]),
    });
    expect(await runBackgroundSync(deps)).toBe("quiet");
    expect(notified).toEqual([]);
    expect(written).toEqual([{ tags: ["aa"], lastSeen: ["x:0"] }]);
  });

  it("survives a chain error without throwing", async () => {
    const { deps, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa"], lastSeen: [] }),
      listOutpointsForTag: () => Promise.reject(new Error("rpc down")),
    });
    expect(await runBackgroundSync(deps)).toBe("quiet");
    expect(notified).toEqual([]);
    expect(written).toEqual([]);
  });

  it("records nothing when the notification fails", async () => {
    const notifyAttempts: number[] = [];
    const { deps, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa"], lastSeen: [] }),
      listOutpointsForTag: () => Promise.resolve(["x:0"]),
      notify: (count) => {
        // Record the attempt BEFORE rejecting, so the assertion below proves
        // notify was actually invoked rather than being trivially true
        // because the overridden notify never runs.
        notifyAttempts.push(count);
        return Promise.reject(new Error("notification channel down"));
      },
    });
    expect(await runBackgroundSync(deps)).toBe("quiet");
    expect(notifyAttempts).toEqual([1]);
    expect(notified).toEqual([]);
    expect(written).toEqual([]);
  });

  it("does not let a failing tag suppress notification for a healthy one", async () => {
    const { deps, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa", "bb"], lastSeen: [] }),
      listOutpointsForTag: (tag) =>
        tag === "aa" ? Promise.reject(new Error("rpc down")) : Promise.resolve(["z:0"]),
    });
    expect(await runBackgroundSync(deps)).toBe("notified");
    expect(notified).toEqual([1]);
    expect(written).toEqual([{ tags: ["aa", "bb"], lastSeen: ["z:0"] }]);
  });

  it("records no sighting when no tag answers", async () => {
    const { deps, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa"], lastSeen: [] }),
      listOutpointsForTag: () => Promise.reject(new Error("rpc down")),
    });
    expect(await runBackgroundSync(deps)).toBe("quiet");
    expect(notified).toEqual([]);
    expect(written).toEqual([]);
  });

  it("carries a failing tag's earlier outpoints forward instead of dropping them", async () => {
    // Tag "bb" answered on an earlier tick and its outpoint "b:0" is already
    // in lastSeen. This tick "bb" transiently fails while "aa" succeeds with
    // a genuinely new outpoint. The write must NOT drop "b:0" — otherwise
    // "bb" reporting the same still-unspent outpoint on a later tick would
    // look new again and fire a spurious duplicate notification.
    const { deps, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa", "bb"], lastSeen: ["b:0"] }),
      listOutpointsForTag: (tag) =>
        tag === "aa" ? Promise.resolve(["a:0"]) : Promise.reject(new Error("rpc down")),
    });
    expect(await runBackgroundSync(deps)).toBe("notified");
    expect(notified).toEqual([1]); // only "a:0" is new
    expect(written).toEqual([{ tags: ["aa", "bb"], lastSeen: ["b:0", "a:0"] }]);
  });

  /* ── security property: the locked branch touches no container dependency ── */

  it("never invokes a container-dependent dependency on the locked branch", async () => {
    // runFullSync and refreshTagCache both need an unlocked vault (they reach
    // through AppContainer into MessagingService, which holds identity keys).
    // While locked they must not be called AT ALL — calling them would mean
    // the probe had opened the database or attempted to decrypt.
    const forbidden: string[] = [];
    const { deps, notified } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa", "bb"], lastSeen: [] }),
      listOutpointsForTag: (tag) => Promise.resolve(tag === "aa" ? ["x:0"] : ["y:0"]),
      runFullSync: () => {
        forbidden.push("runFullSync");
        return Promise.resolve();
      },
      refreshTagCache: () => {
        forbidden.push("refreshTagCache");
        return Promise.resolve();
      },
    });

    expect(await runBackgroundSync(deps)).toBe("notified");
    // Positive proof the locked path actually ran (so the assertion below is
    // not trivially true because nothing happened at all).
    expect(notified).toEqual([2]);
    expect(forbidden).toEqual([]);
  });

  it("never invokes a container-dependent dependency on any locked outcome", async () => {
    const outcomes: string[] = [];
    for (const readTagCache of [
      () => Promise.resolve(undefined), // "idle"
      () => Promise.resolve({ tags: [] as string[], lastSeen: [] as string[] }), // "idle"
      () => Promise.resolve({ tags: ["aa"], lastSeen: ["x:0"] }), // "quiet"
      () => Promise.resolve({ tags: ["aa"], lastSeen: [] }), // "notified"
    ]) {
      const forbidden: string[] = [];
      const { deps } = makeDeps({
        readTagCache,
        listOutpointsForTag: () => Promise.resolve(["x:0"]),
        runFullSync: () => {
          forbidden.push("runFullSync");
          return Promise.resolve();
        },
        refreshTagCache: () => {
          forbidden.push("refreshTagCache");
          return Promise.resolve();
        },
      });
      outcomes.push(await runBackgroundSync(deps));
      expect(forbidden).toEqual([]);
    }
    // Every locked outcome was genuinely exercised.
    expect(outcomes).toEqual(["idle", "idle", "quiet", "notified"]);
  });

  it("propagates a full-sync failure instead of reporting a successful sync", async () => {
    // AppContainer can reach state "ready" with no MessagingService, in which
    // case background-sync.ts throws rather than silently no-opping — the tick
    // must fail so WorkManager retries, not claim a sync that never ran.
    const { deps } = makeDeps({
      isVaultUnlocked: () => true,
      runFullSync: () => Promise.reject(new Error("messaging is unavailable")),
    });
    await expect(runBackgroundSync(deps)).rejects.toThrow("messaging is unavailable");
  });

  it("still records the sighting when every tag answers but none report anything", async () => {
    // Distinct from "no tag answers": here every tag succeeds, they just
    // have nothing to report. This is the answered === tags.length path, so
    // the cache write still happens (with an empty lastSeen), unlike the
    // all-failed case which skips the write entirely.
    const { deps, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa", "bb"], lastSeen: [] }),
      listOutpointsForTag: () => Promise.resolve([]),
    });
    expect(await runBackgroundSync(deps)).toBe("quiet");
    expect(notified).toEqual([]);
    expect(written).toEqual([{ tags: ["aa", "bb"], lastSeen: [] }]);
  });
});
