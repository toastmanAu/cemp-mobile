/**
 * Runs `op`, swallowing any failure — a synchronous throw or a rejected
 * promise — so a best-effort side effect can never surface as an unhandled
 * promise rejection, and never blocks or fails its caller.
 *
 * Pure: no React Native import, so it is unit-tested directly. Used by
 * {@link WorkManagerScheduler} for native-module calls whose failure must
 * not propagate (cancelling background work on wipe is best-effort; the
 * wipe itself must always complete).
 */
export async function bestEffort(op: () => Promise<void>): Promise<void> {
  try {
    await op();
  } catch {
    // Deliberately swallowed — see the module doc comment.
  }
}
