import { StepFailure, loadCtx } from "./chain.js";
import { ORDERED_STEPS, stepRun } from "./steps/run.js";

/**
 * Headless two-user CKB testnet reference client (ckd.txt §20).
 *
 * Usage:
 *   tsx src/main.ts <step> [--state-dir <dir>]
 *
 * Steps: setup | deploy-type | profiles | send | receive | respond |
 *        ack-reclaim | watch | reconcile | run
 *
 * Exit codes: 0 ok · 1 step failure · 2 funding required (setup).
 */

const USAGE = `usage: tsx src/main.ts <step> [--state-dir <dir>]

steps:
  setup        print identities + faucet instructions; gate on testnet funds
  deploy-type  deploy the cemp-message-type contract code cell (alice pays)
  profiles     create alice's and bob's Profile Cells
  send         alice encrypts + publishes a message to bob
  receive      bob discovers + decrypts it
  respond      bob answers (reply linkage + downloaded receipt)
  ack-reclaim  alice discovers the response, then reclaims her message cell
  watch        bob watches the original cell get spent (history kept)
  reconcile    final balance/state accounting + assertions
  run          all of the above, checkpointed between steps

options:
  --state-dir  state directory (default ./.cemp-state; gitignored)`;

interface CliArgs {
  step: string;
  stateDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  let step: string | undefined;
  let stateDir = "./.cemp-state";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--state-dir") {
      const value = argv[++i];
      if (value === undefined) {
        throw new StepFailure("--state-dir requires a value");
      }
      stateDir = value;
    } else if (arg.startsWith("--")) {
      throw new StepFailure(`unknown option ${arg}`);
    } else if (step === undefined) {
      step = arg;
    } else {
      throw new StepFailure(`unexpected extra argument ${arg}`);
    }
  }
  if (step === undefined) {
    throw new StepFailure("no step given");
  }
  return { step, stateDir };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const step =
    args.step === "run"
      ? { name: "run", fn: stepRun }
      : ORDERED_STEPS.find((candidate) => candidate.name === args.step);
  if (step === undefined) {
    throw new StepFailure(`unknown step ${JSON.stringify(args.step)}`);
  }
  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] ${message}`);
  };
  log(`step=${step.name} state-dir=${args.stateDir} network=ckb_testnet`);
  const ctx = await loadCtx(args.stateDir);
  await step.fn(ctx, log);
}

main().catch((err: unknown) => {
  if (err instanceof StepFailure) {
    console.error(`\n✗ ${err.message}`);
    if (err.exitCode === 2 || err.message.startsWith("usage")) {
      console.error(USAGE);
    }
    process.exitCode = err.exitCode;
    return;
  }
  console.error(err);
  process.exitCode = 1;
});
