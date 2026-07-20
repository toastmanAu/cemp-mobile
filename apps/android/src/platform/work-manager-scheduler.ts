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
import { bestEffort } from "./best-effort";
import { SpecRegistry } from "./scheduler-coalesce";

interface CempSchedulerNativeModule {
  schedulePeriodic(
    intervalMs: number,
    requiresNetwork: boolean,
    replaceExisting: boolean,
  ): Promise<void>;
  scheduleOneShot(id: string, delayMs: number): Promise<void>;
  cancel(id: string): Promise<void>;
  cancelPeriodic(): Promise<void>;
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

  /**
   * `SyncEngine.start()` calls this once per worker, and runs on every vault
   * unlock — so most calls here are re-registrations of a tick WorkManager is
   * already running. The registry returns `undefined` for those, and we make
   * no native call at all: re-enqueueing would restart the 15-minute period
   * and a frequently-unlocking user would never receive a background tick.
   */
  schedulePeriodic(spec: { id: string; intervalMs: number; requiresNetwork: boolean }): void {
    const update = this.#registry.add(spec);
    if (update === undefined) {
      return;
    }
    void this.#module().schedulePeriodic(
      update.tick.intervalMs,
      update.tick.requiresNetwork,
      update.replaceExisting,
    );
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
    const update = this.#registry.remove(id);
    if (update !== undefined) {
      // Dropping the shortest spec promotes the next-shortest, which is a real
      // parameter change and so must replace the running tick, not defer to it.
      void bestEffort(() =>
        this.#module().schedulePeriodic(
          update.tick.intervalMs,
          update.tick.requiresNetwork,
          update.replaceExisting,
        ),
      );
    }
    // Best-effort: a missing native module or a rejected native promise here
    // must not become an unhandled rejection (see `bestEffort`).
    void bestEffort(() => this.#module().cancel(id));
  }

  /**
   * Cancel the coalesced periodic tick itself. NOT part of the `Scheduler`
   * interface — the engine has no reason to stop its own heartbeat. This
   * exists for `AppContainer.wipe()`, so no background work keeps running for
   * a wiped identity.
   *
   * Best-effort, like `cancel` above: the returned promise never rejects, so
   * a missing native module or a rejected native call can never block or
   * fail the wipe that calls this. It IS awaited by the caller, purely to
   * sequence "stop the tick" ahead of "wipe the vault" — not because failure
   * here needs to be observed.
   */
  cancelPeriodic(): Promise<void> {
    return bestEffort(() => this.#module().cancelPeriodic());
  }
}
