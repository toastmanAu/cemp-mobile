import { watchOutpointUntilSpent } from "@cemp/ckb";
import { StepFailure } from "./shared.js";
import type { StepFn } from "./shared.js";

/**
 * watch — Bob watches Alice's original message outpoint until it is spent
 * (spec §7.4), then marks his local history record `remote_reclaimed`. The
 * record is KEPT (rule 8): losing the transport cell never deletes local
 * history.
 */
export const stepWatch: StepFn = async (ctx, log) => {
  const bob = ctx.identities.bob;
  const original = ctx.shared.messages.aliceToBob;
  if (original === null) {
    throw new StepFailure("no alice→bob message mapping — run the send step first");
  }
  if (ctx.shared.steps.watch === true) {
    log("watch already complete (checkpoint) — original cell is spent.");
    return;
  }

  log(`watching ${original.outPoint.txHash}:${original.outPoint.index} until spent (≤ 5 min)…`);
  const result = await watchOutpointUntilSpent(ctx.client, original.outPoint, {
    pollIntervalMs: 5_000,
    timeoutMs: 300_000,
  });
  if (result !== "spent") {
    throw new StepFailure(
      "timed out waiting for alice's original message cell to be spent — re-run the watch step",
    );
  }
  const record = bob.state.messages.find(
    (m) => m.direction === "received" && m.messageId === original.messageId,
  );
  if (record === undefined) {
    throw new StepFailure("bob has no local record of alice's message — run receive first");
  }
  record.status = "remote_reclaimed"; // history kept (rule 8)
  ctx.shared.steps.watch = true;
  ctx.save();
  log("original cell was spent (reclaimed by alice); bob's local record marked remote_reclaimed.");
};
