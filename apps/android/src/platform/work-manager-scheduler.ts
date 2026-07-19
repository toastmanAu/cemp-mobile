/**
 * {@link Scheduler} over the app-local CempScheduler Kotlin module
 * (android/app/src/main/java/com/cempmobile/background, AndroidX WorkManager).
 *
 * The engine schedules one periodic request per worker; this adapter coalesces
 * them into a single WorkManager tick (Phase 9 design D4) because booting the
 * React Native JS context is the expensive part. Retry one-shots map 1:1.
 */

import { NativeModules } from "react-native";
import type { Scheduler } from "@cemp/sync";
import { SpecRegistry } from "./scheduler-coalesce";

interface CempSchedulerNativeModule {
  schedulePeriodic(intervalMs: number, requiresNetwork: boolean): Promise<void>;
  scheduleOneShot(id: string, delayMs: number): Promise<void>;
  cancel(id: string): Promise<void>;
}

export class WorkManagerScheduler implements Scheduler {
  readonly #registry = new SpecRegistry();

  #module(): CempSchedulerNativeModule {
    const module = NativeModules.CempScheduler as CempSchedulerNativeModule | undefined;
    if (module === undefined) {
      throw new Error("WorkManagerScheduler: the CempScheduler native module is not linked");
    }
    return module;
  }

  schedulePeriodic(spec: { id: string; intervalMs: number; requiresNetwork: boolean }): void {
    const tick = this.#registry.add(spec);
    if (tick === undefined) {
      return;
    }
    void this.#module().schedulePeriodic(tick.intervalMs, tick.requiresNetwork);
  }

  scheduleOneShot(id: string, delayMs: number): void {
    void this.#module().scheduleOneShot(id, delayMs);
  }

  /**
   * The periodic tick is always enqueued under the fixed WorkManager name
   * "cemp-sync-tick" (CempSchedulerModule.kt), never a per-worker id — the
   * TypeScript side coalesces every worker into that one request, so there
   * is no periodic work individually addressable by id. The sync engine
   * (packages/cemp-sync/src/engine.ts runWorker) only ever calls `cancel`
   * with a one-shot `:retry` id, which this reaches unmodified; if anything
   * ever called `cancel(workerId)` expecting to pull that worker out of the
   * periodic tick, it would silently no-op against the native side (though
   * the registry lookup below still drops it from future coalescing).
   */
  cancel(id: string): void {
    this.#registry.remove(id);
    void this.#module().cancel(id);
  }
}
