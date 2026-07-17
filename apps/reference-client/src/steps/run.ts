import type { StepFn } from "./shared.js";
import { stepSetup } from "./setup.js";
import { stepDeployType } from "./deploy-type.js";
import { stepProfiles } from "./profiles.js";
import { stepSend } from "./send.js";
import { stepReceive } from "./receive.js";
import { stepRespond } from "./respond.js";
import { stepAckReclaim } from "./ack-reclaim.js";
import { stepWatch } from "./watch.js";
import { stepReconcile } from "./reconcile.js";

/** The full lifecycle in order (ckd.txt §20); every step checkpoints. */
export const ORDERED_STEPS: readonly { name: string; fn: StepFn }[] = [
  { name: "setup", fn: stepSetup },
  { name: "deploy-type", fn: stepDeployType },
  { name: "profiles", fn: stepProfiles },
  { name: "send", fn: stepSend },
  { name: "receive", fn: stepReceive },
  { name: "respond", fn: stepRespond },
  { name: "ack-reclaim", fn: stepAckReclaim },
  { name: "watch", fn: stepWatch },
  { name: "reconcile", fn: stepReconcile },
];

export const stepRun: StepFn = async (ctx, log) => {
  for (const step of ORDERED_STEPS) {
    log(`\n═══ step: ${step.name} ═══`);
    await step.fn(ctx, log);
  }
  log("\nrun complete — full CEMP lifecycle proven on testnet (ckd.txt §20).");
};
