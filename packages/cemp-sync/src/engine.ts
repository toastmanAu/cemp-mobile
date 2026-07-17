/**
 * Background sync engine (spec Phase 9; §12).
 *
 * Platform-neutral: workers are plain async functions registered with a
 * {@link Scheduler} — the Android WorkManager bridge (apps/android, device
 * phase) maps `schedulePeriodic` to PeriodicWorkRequest (15-minute floor,
 * NetworkType.CONNECTED for `requiresNetwork`) and `scheduleOneShot` to a
 * OneTimeWorkRequest retry. The engine owns:
 *
 * - **Worker-level leases** (`worker:<id>`): two engines (app + a raced
 *   WorkManager invocation) never run the same worker concurrently
 *   (task 9/10 — see WorkerLeaseRepository).
 * - **Retry with exponential backoff** (task 3): a failing worker is
 *   rescheduled via `scheduleOneShot(id, backoff.delay(attempt))`; the
 *   attempt counter persists in a sync cursor, so a reboot does not reset it
 *   (exit criterion: reboot does not lose scheduled work).
 * - **Foreground catch-up** (task 5): `runAllNow()` drains every worker once,
 *   in registration order, for app-foreground and post-reconnect catch-up.
 */

import type { SyncCursorRepository, WorkerLeaseRepository } from "@cemp/database";
import type { BackoffPolicy } from "./retry.js";

export interface WorkerSpec {
  readonly id: string;
  /** Battery-conscious periodic interval (task 6; see workers.ts rationale). */
  readonly intervalMs: number;
  /** Maps to WorkManager NetworkType.CONNECTED on Android (task 2). */
  readonly requiresNetwork: boolean;
  readonly run: () => Promise<void>;
}

export interface Scheduler {
  schedulePeriodic(spec: { id: string; intervalMs: number; requiresNetwork: boolean }): void;
  scheduleOneShot(id: string, delayMs: number): void;
  cancel(id: string): void;
}

/** Reference scheduler (tests + dev): records intent, no timers. */
export class InMemoryScheduler implements Scheduler {
  readonly periodic = new Map<string, { intervalMs: number; requiresNetwork: boolean }>();
  readonly oneShots = new Map<string, number>();

  schedulePeriodic(spec: { id: string; intervalMs: number; requiresNetwork: boolean }): void {
    this.periodic.set(spec.id, {
      intervalMs: spec.intervalMs,
      requiresNetwork: spec.requiresNetwork,
    });
  }

  scheduleOneShot(id: string, delayMs: number): void {
    this.oneShots.set(id, delayMs);
  }

  cancel(id: string): void {
    this.periodic.delete(id);
    this.oneShots.delete(id);
  }
}

export type WorkerRunResult = "success" | "retry" | "skipped-lease" | "unknown-worker";

const WORKER_LEASE_TTL_MS = 10 * 60_000;

export interface SyncEngineDeps {
  readonly scheduler: Scheduler;
  readonly leases: WorkerLeaseRepository;
  readonly cursors: SyncCursorRepository;
  readonly workers: readonly WorkerSpec[];
  readonly backoff: BackoffPolicy;
  /** Unique per boot (random) — distinguishes this engine's leases. */
  readonly engineId: string;
}

export class SyncEngine {
  readonly #deps: SyncEngineDeps;
  readonly #workers: ReadonlyMap<string, WorkerSpec>;

  constructor(deps: SyncEngineDeps) {
    this.#deps = deps;
    this.#workers = new Map(deps.workers.map((worker) => [worker.id, worker]));
  }

  /** Register every worker with the scheduler (idempotent re-registration). */
  start(): void {
    for (const worker of this.#workers.values()) {
      this.#deps.scheduler.schedulePeriodic({
        id: worker.id,
        intervalMs: worker.intervalMs,
        requiresNetwork: worker.requiresNetwork,
      });
    }
  }

  /** The persisted retry-attempt counter for a worker (survives reboot). */
  async retryAttempt(workerId: string): Promise<number> {
    const raw = await this.#deps.cursors.get(`retry:${workerId}`);
    if (raw === null) {
      return 0;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  /**
   * Run one worker under its lease. A rival live lease skips the run; a
   * failure is rescheduled with exponential backoff (task 3).
   */
  async runWorker(workerId: string): Promise<WorkerRunResult> {
    const worker = this.#workers.get(workerId);
    if (worker === undefined) {
      return "unknown-worker";
    }
    const lease = await this.#deps.leases.acquire(
      `worker:${workerId}`,
      this.#deps.engineId,
      WORKER_LEASE_TTL_MS,
    );
    if (lease === null) {
      return "skipped-lease";
    }
    try {
      await worker.run();
      await this.#deps.cursors.delete(`retry:${workerId}`);
      this.#deps.scheduler.cancel(`${workerId}:retry`);
      return "success";
    } catch {
      const attempt = await this.retryAttempt(workerId);
      await this.#deps.cursors.set(`retry:${workerId}`, String(attempt + 1));
      this.#deps.scheduler.scheduleOneShot(`${workerId}:retry`, this.#deps.backoff.delay(attempt));
      return "retry";
    } finally {
      await this.#deps.leases.release(`worker:${workerId}`, this.#deps.engineId);
    }
  }

  /** Foreground catch-up (task 5): drain every worker once, in order. */
  async runAllNow(): Promise<Record<string, WorkerRunResult>> {
    const results: Record<string, WorkerRunResult> = {};
    for (const worker of this.#workers.values()) {
      results[worker.id] = await this.runWorker(worker.id);
    }
    return results;
  }
}
