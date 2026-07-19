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
