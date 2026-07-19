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
    const { deps, notified } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa"], lastSeen: [] }),
      listOutpointsForTag: () => Promise.reject(new Error("rpc down")),
    });
    expect(await runBackgroundSync(deps)).toBe("quiet");
    expect(notified).toEqual([]);
  });
});
