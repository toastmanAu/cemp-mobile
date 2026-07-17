import { StepFailure, balanceSnapshot, formatCkb } from "./shared.js";
import type { StepFn } from "./shared.js";
import { oneFeeMargin, reconcileSide } from "../reconcile-math.js";
import type { SideInput } from "../reconcile-math.js";

/**
 * reconcile — final accounting table + assertions (exit 1 on any mismatch):
 *
 *  1. Alice's original message cell is DEAD on-chain;
 *  2. Bob's history shows it remote_reclaimed (he saw it spent);
 *  3. both messages were decrypted and recorded on the receiving side;
 *  4. spendable deltas: alice == -(her fees + contract + profile capacity),
 *     bob == -(his fees + profile + still-live response cell capacity);
 *  5. total-balance deltas == -(fees) on both sides (every created cell keeps
 *     its owner's lock; the reclaim returned the message capacity).
 *
 * Note on the milestone brief's formulas: "bob == -(fees + profile)" omits
 * Bob's response message cell, whose capacity is locked in a sender-owned
 * protocol cell exactly like Alice's unreclaimed message would be. It is
 * included here; the deviation is listed in the task report.
 */
export const stepReconcile: StepFn = async (ctx, log) => {
  const alice = ctx.identities.alice;
  const bob = ctx.identities.bob;
  const original = ctx.shared.messages.aliceToBob;
  const response = ctx.shared.messages.bobToAlice;
  if (original === null || response === null) {
    throw new StepFailure("message mappings missing — run the full flow first");
  }

  const failures: string[] = [];
  const check = (ok: boolean, label: string): void => {
    log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) {
      failures.push(label);
    }
  };

  // 1. original message cell dead. The node reports a just-spent outpoint as
  // "dead" or "unknown" depending on its spent-cell cache — both mean gone
  // (the same semantics watchOutpointUntilSpent uses: anything ≠ live).
  const live = await ctx.client.getLiveCell(original.outPoint);
  check(live.status !== "live", `alice's message cell is spent on-chain (status: ${live.status})`);

  // 2. bob saw it spent
  const bobRecord = bob.state.messages.find(
    (m) => m.direction === "received" && m.messageId === original.messageId,
  );
  check(
    bobRecord?.status === "remote_reclaimed",
    `bob marked the original cell remote_reclaimed (status: ${bobRecord?.status ?? "missing"})`,
  );

  // 3. both decrypted correctly
  check(bobRecord !== undefined, "bob decrypted + recorded alice's message");
  const aliceRecord = alice.state.messages.find(
    (m) => m.direction === "received" && m.messageId === response.messageId,
  );
  check(aliceRecord !== undefined, "alice decrypted + recorded bob's response");
  const aliceSent = alice.state.messages.find(
    (m) => m.direction === "sent" && m.messageId === original.messageId,
  );
  check(
    aliceSent?.status === "reclaimed",
    `alice's history shows the original message reclaimed (status: ${aliceSent?.status ?? "missing"})`,
  );

  // 4./5. balance deltas vs live indexer balances
  const sides: SideInput[] = [];
  for (const name of ["alice", "bob"] as const) {
    const identity = ctx.identities[name];
    const before = identity.state.balanceBefore;
    if (before === null) {
      throw new StepFailure(`${name} has no balance snapshot — run the setup step first`);
    }
    const after = await balanceSnapshot(ctx.client, identity.lock);
    const fees = Object.values(identity.state.fees).map((fee) => BigInt(fee));
    const locked: bigint[] = [];
    if (name === "alice") {
      if (ctx.shared.contractCellCapacity !== null) {
        locked.push(BigInt(ctx.shared.contractCellCapacity));
      }
    } else {
      // Bob's response cell is still live and sender-owned: locked like a profile.
      locked.push(BigInt(response.capacity));
    }
    if (identity.state.profileCapacity !== null) {
      locked.push(BigInt(identity.state.profileCapacity));
    }
    sides.push({
      name,
      spendableBefore: BigInt(before.spendable),
      spendableAfter: after.spendable,
      totalBefore: BigInt(before.total),
      totalAfter: after.total,
      fees,
      lockedCapacities: locked,
      margin: oneFeeMargin(fees),
    });
  }

  log("");
  log(
    "identity │ spendable before → after │ total before → after │ fees │ locked in protocol cells",
  );
  for (const side of sides) {
    const feeSum = side.fees.reduce((a, b) => a + b, 0n);
    const lockSum = side.lockedCapacities.reduce((a, b) => a + b, 0n);
    log(
      `${side.name.padEnd(8)} │ ${formatCkb(side.spendableBefore)} → ${formatCkb(side.spendableAfter)} │ ` +
        `${formatCkb(side.totalBefore)} → ${formatCkb(side.totalAfter)} │ ` +
        `${formatCkb(feeSum)} │ ${formatCkb(lockSum)}`,
    );
  }
  log("");
  for (const side of sides) {
    for (const delta of reconcileSide(side)) {
      check(
        delta.ok,
        `${delta.label}: expected ${formatCkb(delta.expected)}, actual ${formatCkb(delta.actual)} ` +
          `(margin ±${formatCkb(delta.margin)})`,
      );
    }
  }

  // Persist the "after" snapshot for the report (before stays untouched).
  for (const side of sides) {
    const identity = ctx.identities[side.name as "alice" | "bob"];
    identity.state.balanceAfter = {
      total: side.totalAfter.toString(),
      spendable: side.spendableAfter.toString(),
    };
  }
  ctx.save();

  if (failures.length > 0) {
    throw new StepFailure(`reconcile failed (${failures.length} assertion(s))`);
  }
  log("reconcile complete: all assertions hold.");
};
