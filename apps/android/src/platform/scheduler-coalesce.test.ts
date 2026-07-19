import { describe, expect, it } from "vitest";
import { WORKMANAGER_MIN_INTERVAL_MS, SpecRegistry, coalesce } from "./scheduler-coalesce";

describe("scheduler coalescing", () => {
  it("returns undefined when nothing is scheduled", () => {
    expect(coalesce([])).toBeUndefined();
  });

  it("uses the shortest interval across all workers", () => {
    const tick = coalesce([
      { id: "a", intervalMs: 30 * 60_000, requiresNetwork: true },
      { id: "b", intervalMs: 20 * 60_000, requiresNetwork: true },
    ]);
    expect(tick).toEqual({ intervalMs: 20 * 60_000, requiresNetwork: true });
  });

  it("raises intervals below the WorkManager floor", () => {
    const tick = coalesce([{ id: "a", intervalMs: 60_000, requiresNetwork: false }]);
    expect(tick?.intervalMs).toBe(WORKMANAGER_MIN_INTERVAL_MS);
  });

  it("requires network when ANY worker does, since the tick runs them all", () => {
    const tick = coalesce([
      { id: "a", intervalMs: 20 * 60_000, requiresNetwork: false },
      { id: "b", intervalMs: 20 * 60_000, requiresNetwork: true },
    ]);
    expect(tick?.requiresNetwork).toBe(true);
  });

  it("requires no network when no worker does", () => {
    const tick = coalesce([{ id: "a", intervalMs: 20 * 60_000, requiresNetwork: false }]);
    expect(tick?.requiresNetwork).toBe(false);
  });
});

describe("SpecRegistry", () => {
  it("yields one tick at the shortest interval across several added specs", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 30 * 60_000, requiresNetwork: true });
    const tick = registry.add({ id: "b", intervalMs: 20 * 60_000, requiresNetwork: true });
    expect(tick).toEqual({ intervalMs: 20 * 60_000, requiresNetwork: true });
  });

  it("keeps the shortest interval when a new spec does not beat it", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    const tick = registry.add({ id: "b", intervalMs: 30 * 60_000, requiresNetwork: true });
    expect(tick).toEqual({ intervalMs: 20 * 60_000, requiresNetwork: true });
  });

  it("promotes the next-shortest interval when the shortest is removed", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    registry.add({ id: "b", intervalMs: 30 * 60_000, requiresNetwork: true });
    const tick = registry.remove("a");
    expect(tick).toEqual({ intervalMs: 30 * 60_000, requiresNetwork: true });
  });

  it("leaves nothing to schedule once the last spec is removed", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    const tick = registry.remove("a");
    expect(tick).toBeUndefined();
  });

  it("treats removing an id that was never added as a harmless no-op", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    const tick = registry.remove("never-added");
    expect(tick).toEqual({ intervalMs: 20 * 60_000, requiresNetwork: true });
  });
});
