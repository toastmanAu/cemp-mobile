import { faucetClaimInstructions } from "@cemp/ckb";
import { tryFaucetClaim } from "../faucet.js";
import { StepFailure, balanceSnapshot, formatCkb, runCheckpointed } from "./shared.js";
import type { StepFn } from "./shared.js";

/**
 * setup — print both addresses + faucet instructions, then gate on funds.
 *
 * Funding minimums (spendable balance): occupied capacity costs 1 CKB per
 * on-chain BYTE, and the v1 objects are large (the contract binary alone is
 * 26.7 KB; an ML-DSA-65 public key is 1,952 bytes):
 *
 *   contract code cell  ≈ 26.7 KB → ~26,750 CKB + fee        (deploy-type)
 *   profile cell        ≈ 3.4 KB  → ~3,420 CKB + fee         (profiles)
 *   message cell        ≈ 1.8 KB  → ~1,800 CKB + fee         (send/respond)
 *
 * Alice additionally pays for the deployment, so her gate is much higher.
 * The milestone brief's "~350 CKB deploy / ~700 CKB per identity" figures
 * are off by two orders of magnitude (they miss the 1-CKB-per-byte occupied
 * capacity rule) and are reported as a spec/task deviation. The faucet
 * dispenses 10,000 CKB per claim (300,000/month/address), so Alice needs
 * ~4 claims and Bob 1.
 */
export const MIN_SPENDABLE = {
  alice: 32_500n * 100_000_000n,
  bob: 5_500n * 100_000_000n,
} as const;

const FUNDING_POLL_INTERVAL_MS = 20_000;
const FUNDING_POLL_TIMEOUT_MS = 600_000; // ~10 minutes

export const FUNDING_EXIT_CODE = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const stepSetup: StepFn = async (ctx, log) => {
  const alice = ctx.identities.alice;
  const bob = ctx.identities.bob;

  if (ctx.shared.steps.setup === true) {
    log("setup already complete (checkpoint) — identities:");
    printIdentity(log, "alice", alice.address, alice.state.profileId);
    printIdentity(log, "bob", bob.address, bob.state.profileId);
    return;
  }

  log("derived deterministic testnet identities (throwaway — never send real funds):");
  printIdentity(log, "alice", alice.address, alice.state.profileId);
  printIdentity(log, "bob", bob.address, bob.state.profileId);
  log(`alice lock args: ${alice.lockArgs}`);
  log(`bob   lock args: ${bob.lockArgs}`);

  const underfunded = async (): Promise<("alice" | "bob")[]> => {
    const lacking: ("alice" | "bob")[] = [];
    for (const name of ["alice", "bob"] as const) {
      const identity = ctx.identities[name];
      const balance = await balanceSnapshot(ctx.client, identity.lock);
      log(
        `${name} balance: spendable ${formatCkb(balance.spendable)} CKB ` +
          `(total ${formatCkb(balance.total)}, ${balance.cellCount} cells), ` +
          `minimum ${formatCkb(MIN_SPENDABLE[name])} CKB`,
      );
      if (balance.spendable < MIN_SPENDABLE[name]) {
        lacking.push(name);
      }
    }
    return lacking;
  };

  let lacking = await underfunded();
  if (lacking.length > 0) {
    for (const name of lacking) {
      const identity = ctx.identities[name];
      log(`— ${name} needs funding:`);
      log(faucetClaimInstructions(identity.address));
      // Single best-effort automated claim; manual claiming is the supported path.
      const claim = await tryFaucetClaim(identity.address);
      log(`automated faucet claim for ${name}: ${claim.detail}`);
    }
    const deadline = Date.now() + FUNDING_POLL_TIMEOUT_MS;
    while (lacking.length > 0 && Date.now() < deadline) {
      log(`polling for funds (up to ${FUNDING_POLL_TIMEOUT_MS / 60_000} min total)…`);
      await sleep(FUNDING_POLL_INTERVAL_MS);
      lacking = await underfunded();
    }
  }

  if (lacking.length > 0) {
    const lines = lacking.map((name) => `  ${name}: ${ctx.identities[name].address}`).join("\n");
    throw new StepFailure(
      `FUNDING REQUIRED — send testnet CKB (https://faucet.nervos.org) to:\n${lines}\n` +
        `then re-run this step. See apps/reference-client/FUNDING.md.`,
      FUNDING_EXIT_CODE,
    );
  }

  // Snapshot the "before" balances every later reconciliation compares against.
  for (const name of ["alice", "bob"] as const) {
    const identity = ctx.identities[name];
    const balance = await balanceSnapshot(ctx.client, identity.lock);
    identity.state.balanceBefore = {
      total: balance.total.toString(),
      spendable: balance.spendable.toString(),
    };
    ctx.saveIdentity(name);
    log(
      `${name} funded: spendable ${formatCkb(balance.spendable)} CKB, ` +
        `total ${formatCkb(balance.total)} CKB (snapshot recorded)`,
    );
  }
  await runCheckpointed(ctx, "setup", async () => {
    // Marker only — the snapshots above are the checkpoint payload.
  });
  log("setup complete.");
};

function printIdentity(
  log: (m: string) => void,
  name: string,
  address: string,
  profileId: string | null,
): void {
  log(`${name} address: ${address}`);
  log(`${name} profile id: ${profileId ?? "(not created yet)"}`);
}
