/**
 * Collapse the engine's per-worker periodic requests into ONE WorkManager tick
 * (Phase 9 design D4).
 *
 * A literal 1:1 mapping would create a WorkManager request per worker, each
 * booting a fresh React Native JS context — the expensive part of a tick.
 * WorkManager's floor is 15 minutes and every worker interval is >= 15 minutes,
 * so a single tick running `runAllNow()` is behaviourally equivalent.
 *
 * Pure: no React Native imports, so it is unit-tested directly.
 */

/** WorkManager rejects periodic work below 15 minutes. */
export const WORKMANAGER_MIN_INTERVAL_MS = 15 * 60_000;

export interface PeriodicSpec {
  readonly id: string;
  readonly intervalMs: number;
  readonly requiresNetwork: boolean;
}

export interface CoalescedTick {
  readonly intervalMs: number;
  readonly requiresNetwork: boolean;
}

export function coalesce(specs: readonly PeriodicSpec[]): CoalescedTick | undefined {
  if (specs.length === 0) {
    return undefined;
  }
  const shortest = Math.min(...specs.map((spec) => spec.intervalMs));
  return {
    intervalMs: Math.max(shortest, WORKMANAGER_MIN_INTERVAL_MS),
    // The single tick runs every worker, so it must satisfy the strictest
    // constraint any of them declared.
    requiresNetwork: specs.some((spec) => spec.requiresNetwork),
  };
}

/** A tick the caller must actually push to WorkManager, and how. */
export interface TickUpdate {
  readonly tick: CoalescedTick;
  /**
   * Whether the enqueue must REPLACE what is already scheduled
   * (ExistingPeriodicWorkPolicy.UPDATE) rather than defer to it (KEEP).
   *
   * `true` only when this registry previously handed the adapter a different
   * tick, so the change genuinely has to take effect. `false` for the first
   * tick of a process, where any already-scheduled work is by assumption the
   * same one a previous process enqueued and must keep its running period.
   */
  readonly replaceExisting: boolean;
}

function sameTick(a: CoalescedTick, b: CoalescedTick): boolean {
  return a.intervalMs === b.intervalMs && a.requiresNetwork === b.requiresNetwork;
}

/**
 * Bookkeeping for the specs behind a coalesced tick: which worker asked for
 * what, so the tick can be recomputed as workers come and go.
 *
 * This lived inline in `WorkManagerScheduler` (apps/android/src/platform,
 * react-native import) where it could never run under vitest, even though
 * it has no dependency on React Native itself. Pulled out here so the
 * insert/delete/recompute logic is exercised directly; the RN adapter
 * becomes a thin pass-through that just forwards the result to the native
 * module.
 *
 * The registry also owns the re-enqueue decision, because it is the only
 * thing that knows the previously-scheduled tick. `SyncEngine.start()` runs
 * on every vault unlock and re-adds all ~8 workers, which would otherwise be
 * ~8 native `enqueueUniquePeriodicWork` calls that each reset WorkManager's
 * 15-minute period — a user who unlocks more often than that would never see
 * a background tick fire at all. Returning `undefined` for "nothing changed"
 * collapses those 8 calls to 0 after the first unlock.
 */
export class SpecRegistry {
  readonly #specs = new Map<string, PeriodicSpec>();
  /** The last tick handed to the caller to enqueue, if any. */
  #scheduled: CoalescedTick | undefined;

  /**
   * Registers or replaces `spec`, returning the tick to enqueue now, or
   * `undefined` when the native scheduler needs no call at all — either
   * nothing is scheduled, or the coalesced tick is unchanged.
   */
  add(spec: PeriodicSpec): TickUpdate | undefined {
    this.#specs.set(spec.id, spec);
    return this.#recompute();
  }

  /**
   * Removes `id`, returning the tick to enqueue now under the same rules as
   * {@link add}. Removing an id that was never added is a no-op.
   *
   * Emptying the registry does not cancel anything (that is
   * `WorkManagerScheduler.cancelPeriodic`), so `#scheduled` deliberately
   * keeps its last value: it tracks what WorkManager holds, not what the
   * specs currently coalesce to.
   */
  remove(id: string): TickUpdate | undefined {
    this.#specs.delete(id);
    return this.#recompute();
  }

  #recompute(): TickUpdate | undefined {
    const tick = coalesce([...this.#specs.values()]);
    if (tick === undefined) {
      return undefined;
    }
    const previous = this.#scheduled;
    if (previous !== undefined && sameTick(previous, tick)) {
      return undefined;
    }
    this.#scheduled = tick;
    return { tick, replaceExisting: previous !== undefined };
  }
}
