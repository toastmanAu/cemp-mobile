import { runCheckpointed as runCheckpointedState } from "../state.js";

/**
 * Shared step plumbing: everything in `../chain.js` plus the `StepFn`
 * signature all steps implement.
 */
export * from "../chain.js";

import type { Ctx } from "../chain.js";

export type StepFn = (ctx: Ctx, log: (m: string) => void) => Promise<void>;

/** ctx-level checkpoint wrapper (rule 5): skips `fn` when `name` completed. */
export async function runCheckpointed(
  ctx: Ctx,
  name: string,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  const { ran } = await runCheckpointedState(ctx.store, ctx.shared, name, fn);
  return ran;
}
