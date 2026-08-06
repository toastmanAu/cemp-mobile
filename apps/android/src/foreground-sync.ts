/**
 * Autonomous foreground chain sync.
 *
 * THE PROBLEM. Before this existed, the only foreground sync in the app was a
 * `useFocusEffect` on the conversation LIST screen: one sweep per focus, and
 * nothing at all while a chat was open. The chat screen's 3-second timer
 * re-reads the local database, which cannot surface a message that was never
 * fetched from chain — so sitting inside a conversation, a reply could not
 * arrive. The only way to see one was to navigate back out and in again,
 * re-firing the focus effect. Device-reported: "auto-refresh within chat didn't
 * seemingly occur at all, had to exit back to main chat page and spam refresh".
 *
 * Pure and React-Native-free (the `vault-liveness.ts` precedent) so the timing
 * behaviour — the whole of what this file exists for — is unit-testable without
 * a device or a running app.
 *
 * SELF-RESCHEDULING, NOT `setInterval`. The next run is scheduled only after
 * the previous one settles. A `setInterval` whose period is shorter than a slow
 * sync stacks overlapping sweeps that race each other over the same cursors and
 * leases; here the gap is structural rather than a flag a future edit can
 * forget to check. "Every 10s" therefore means 10s of rest between sweeps, not
 * 10s between starts.
 *
 * FOREGROUND ONLY. Background ticks belong to WorkManager (`background-sync.ts`),
 * which enforces its own ~15-minute floor and its own vault-liveness checks.
 * Pausing here when the app backgrounds keeps the two from running sweeps on
 * top of each other and stops a suspended-timer backlog from firing at once on
 * resume.
 */

/** Opaque handle returned by the injected timer, so this stays RN-free. */
export type TimerHandle = unknown;

export interface ForegroundSyncDeps {
  /** One full worker sweep — `messaging.syncNow()` in the app. */
  readonly sync: () => Promise<unknown>;
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
  /**
   * Observe a failed sweep. Failures are NOT fatal: the workers retry with
   * backoff (rule 5), so the loop keeps its cadence and the next sweep tries
   * again. Never receives message content — only the thrown error.
   */
  readonly onError?: (error: unknown) => void;
}

/** Tight cadence while the user is watching a conversation for a reply. */
export const CHAT_CADENCE_MS = 10_000;
/** Relaxed cadence everywhere else in the app. */
export const IDLE_CADENCE_MS = 30_000;

export class ForegroundSync {
  readonly #deps: ForegroundSyncDeps;
  #handle: TimerHandle | null = null;
  #cadenceMs: number = IDLE_CADENCE_MS;
  #started = false;
  #paused = false;
  /** A sweep is in flight; its completion owns the next schedule. */
  #inFlight = false;
  /** The in-flight sweep, so `runNow` can join rather than duplicate it. */
  #current: Promise<void> = Promise.resolve();

  constructor(deps: ForegroundSyncDeps) {
    this.#deps = deps;
  }

  get cadenceMs(): number {
    return this.#cadenceMs;
  }

  get running(): boolean {
    return this.#started && !this.#paused;
  }

  /**
   * Begin syncing. Sweeps immediately — entering the app, or opening a chat,
   * is exactly when the user most wants fresh state — then settles into
   * `cadenceMs`. Starting an already-started scheduler only updates cadence.
   */
  start(cadenceMs: number = IDLE_CADENCE_MS): void {
    if (this.#started) {
      this.setCadence(cadenceMs);
      return;
    }
    this.#started = true;
    this.#paused = false;
    this.#cadenceMs = cadenceMs;
    void this.#run();
  }

  /**
   * Change the cadence. A tightening (list → chat) re-arms the pending timer
   * so the shorter period applies now rather than after the outstanding long
   * wait — without this, opening a chat would still wait out the remaining 30s.
   * A loosening leaves the pending timer alone: firing early is harmless and
   * re-arming would push the next sweep further away than either cadence asks.
   */
  setCadence(cadenceMs: number): void {
    const tightening = cadenceMs < this.#cadenceMs;
    this.#cadenceMs = cadenceMs;
    if (tightening && this.#started && !this.#paused && !this.#inFlight) {
      this.#rearm();
    }
  }

  /**
   * Sweep now, on demand (screen focus, pull-to-refresh), and resolve when it
   * finishes so the caller can show a result.
   *
   * Routed through the scheduler rather than calling `syncNow()` directly:
   * a screen-initiated sweep racing a scheduled one would put two sweeps over
   * the same cursors and worker leases, which is the whole reason the loop is
   * self-rescheduling. When a sweep is already in flight this JOINS it instead
   * of starting another — the caller still learns when fresh data has landed.
   */
  async runNow(): Promise<void> {
    if (this.#inFlight) {
      await this.#current;
      return;
    }
    await this.#run();
  }

  /** Suspend sweeps (app backgrounded). An in-flight sweep is left to finish. */
  pause(): void {
    if (!this.#started || this.#paused) return;
    this.#paused = true;
    this.#cancelTimer();
  }

  /**
   * Resume after `pause()`, sweeping at once to catch up on what was missed.
   *
   * The `#inFlight` check here is deliberately redundant with the one in
   * `#run` — background/foreground churn during a slow sweep is the only path
   * that reaches `#run` re-entrantly, and it is worth refusing at both ends.
   * Mutation-tested: removing EITHER guard alone leaves the no-overlap
   * guarantee intact, and removing both breaks it. Do not "simplify" one away
   * on the grounds that its test still passes.
   */
  resume(): void {
    if (!this.#started || !this.#paused) return;
    this.#paused = false;
    if (!this.#inFlight) {
      void this.#run();
    }
  }

  /** Stop entirely (vault locked, container torn down). Safe to call twice. */
  stop(): void {
    this.#started = false;
    this.#paused = false;
    this.#cancelTimer();
  }

  #cancelTimer(): void {
    if (this.#handle !== null) {
      this.#deps.clearTimer(this.#handle);
      this.#handle = null;
    }
  }

  #rearm(): void {
    this.#cancelTimer();
    this.#handle = this.#deps.setTimer(() => {
      this.#handle = null;
      void this.#run();
    }, this.#cadenceMs);
  }

  async #run(): Promise<void> {
    if (!this.#started || this.#paused || this.#inFlight) return;
    this.#inFlight = true;
    this.#current = this.#sweep();
    await this.#current;
  }

  async #sweep(): Promise<void> {
    try {
      await this.#deps.sync();
    } catch (error: unknown) {
      // A failed sweep never stops the loop — the workers retry with backoff
      // (rule 5) and the next tick tries again. Swallowing it silently is what
      // made the sync failures in this app invisible, so it is surfaced.
      this.#deps.onError?.(error);
    } finally {
      this.#inFlight = false;
      // Re-check: the vault may have locked, or the app backgrounded, while
      // the sweep was in flight.
      if (this.#started && !this.#paused) {
        this.#rearm();
      }
    }
  }
}
