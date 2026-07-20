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
    const update = registry.add({ id: "b", intervalMs: 20 * 60_000, requiresNetwork: true });
    expect(update?.tick).toEqual({ intervalMs: 20 * 60_000, requiresNetwork: true });
  });

  it("enqueues the first tick without replacing, so an already-scheduled one keeps its period", () => {
    const registry = new SpecRegistry();
    const update = registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    expect(update).toEqual({
      tick: { intervalMs: 20 * 60_000, requiresNetwork: true },
      replaceExisting: false,
    });
  });

  // The Phase 9 bug this guards: MessagingService.init() -> engine.start()
  // re-adds every worker on EVERY vault unlock. Each re-add used to return a
  // tick, so the adapter re-enqueued it and WorkManager reset the 15-minute
  // period — a user unlocking more often than that never got a background tick.
  it("does not re-enqueue when the same specs are added again", () => {
    const registry = new SpecRegistry();
    const specs = [
      { id: "a", intervalMs: 20 * 60_000, requiresNetwork: true },
      { id: "b", intervalMs: 30 * 60_000, requiresNetwork: false },
    ];
    for (const spec of specs) {
      registry.add(spec);
    }
    for (const spec of specs) {
      expect(registry.add(spec)).toBeUndefined();
    }
  });

  it("does not re-enqueue for a new spec that does not change the coalesced tick", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    const update = registry.add({ id: "b", intervalMs: 30 * 60_000, requiresNetwork: true });
    expect(update).toBeUndefined();
  });

  it("re-enqueues with replacement when a new spec shortens the coalesced interval", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 30 * 60_000, requiresNetwork: true });
    const update = registry.add({ id: "b", intervalMs: 20 * 60_000, requiresNetwork: true });
    expect(update).toEqual({
      tick: { intervalMs: 20 * 60_000, requiresNetwork: true },
      replaceExisting: true,
    });
  });

  it("re-enqueues with replacement when a new spec tightens the network requirement", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: false });
    const update = registry.add({ id: "b", intervalMs: 20 * 60_000, requiresNetwork: true });
    expect(update).toEqual({
      tick: { intervalMs: 20 * 60_000, requiresNetwork: true },
      replaceExisting: true,
    });
  });

  it("promotes the next-shortest interval when the shortest is removed", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    registry.add({ id: "b", intervalMs: 30 * 60_000, requiresNetwork: true });
    const update = registry.remove("a");
    expect(update).toEqual({
      tick: { intervalMs: 30 * 60_000, requiresNetwork: true },
      replaceExisting: true,
    });
  });

  it("leaves nothing to schedule once the last spec is removed", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    expect(registry.remove("a")).toBeUndefined();
  });

  it("treats removing an id that was never added as a harmless no-op", () => {
    const registry = new SpecRegistry();
    registry.add({ id: "a", intervalMs: 20 * 60_000, requiresNetwork: true });
    expect(registry.remove("never-added")).toBeUndefined();
  });
});
