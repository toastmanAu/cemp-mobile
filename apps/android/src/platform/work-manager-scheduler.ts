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
import { coalesce, type PeriodicSpec } from "./scheduler-coalesce";

interface CempSchedulerNativeModule {
  schedulePeriodic(intervalMs: number, requiresNetwork: boolean): Promise<void>;
  scheduleOneShot(id: string, delayMs: number): Promise<void>;
  cancel(id: string): Promise<void>;
}

const native = NativeModules.CempScheduler as CempSchedulerNativeModule;

export class WorkManagerScheduler implements Scheduler {
  readonly #specs = new Map<string, PeriodicSpec>();

  schedulePeriodic(spec: { id: string; intervalMs: number; requiresNetwork: boolean }): void {
    this.#specs.set(spec.id, spec);
    const tick = coalesce([...this.#specs.values()]);
    if (tick === undefined) {
      return;
    }
    void native.schedulePeriodic(tick.intervalMs, tick.requiresNetwork);
  }

  scheduleOneShot(id: string, delayMs: number): void {
    void native.scheduleOneShot(id, delayMs);
  }

  cancel(id: string): void {
    this.#specs.delete(id);
    void native.cancel(id);
  }
}
