/**
 * Whether the vault is genuinely usable *right now* (Phase 9 background tick).
 *
 * Pure and React-Native-free so it is unit-testable: `background-sync.ts` and
 * `AppContainer` are both behind the `react-native` import boundary, and the
 * decision this file encodes is the whole of the bug it exists to fix.
 *
 * THE PROBLEM. `AppContainer.state` is a cached, UI-facing projection. The
 * container only learns that the vault auto-locked from a 1-second
 * `setInterval`, and the vault only locks itself from a `setTimeout`. React
 * Native freezes JS timers while the app is backgrounded, so BOTH can be
 * arbitrarily overdue when a WorkManager tick wakes the runtime. A tick that
 * trusts either one can route a long-locked vault into the full-sync branch,
 * which then dies when the resumed timers fire and tear the database down
 * underneath it.
 *
 * Three readings, weakest to strongest:
 *   - `containerReady`  — the projection; lags a suspended poll by any amount.
 *   - `vaultUnlocked`   — the vault's own state; lags its own suspended
 *                         `setTimeout` until that timer is finally dispatched.
 *   - `autoLockDeadlineMs` vs now — wall clock, immune to timer suspension.
 *
 * All three must agree before the tick may treat the vault as unlocked.
 */

export interface VaultLiveness {
  /** `AppContainer.state === "ready"`: database open, repositories built. */
  readonly containerReady: boolean;
  /** `vault.state === "unlocked"`: the vault's own view of itself. */
  readonly vaultUnlocked: boolean;
  /** `vault.autoLockDeadlineMs`; `null` when no inactivity timer is armed. */
  readonly autoLockDeadlineMs: number | null;
  /** `Date.now()` at the moment of the decision. */
  readonly nowMs: number;
}

/**
 * True only when the container is ready AND the vault still reports unlocked
 * AND its inactivity deadline has not already passed in wall-clock terms.
 *
 * A `null` deadline with `vaultUnlocked` true is treated as usable: that is the
 * shape of a vault whose timer is not armed, and failing closed there would
 * disable the full-sync branch outright.
 */
export function isVaultUsable(liveness: VaultLiveness): boolean {
  if (!liveness.containerReady || !liveness.vaultUnlocked) {
    return false;
  }
  if (liveness.autoLockDeadlineMs === null) {
    return true;
  }
  return liveness.nowMs < liveness.autoLockDeadlineMs;
}
