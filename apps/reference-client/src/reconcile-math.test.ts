import { describe, expect, it } from "vitest";
import { checkDelta, oneFeeMargin, reconcileSide } from "./reconcile-math.js";

const CKB = 100_000_000n;

/**
 * Fixture modelling a full run: alice funded 10,000 CKB, paid 4 fees
 * (deploy/profile/send/reclaim), locked contract + profile capacity, and
 * reclaimed her message cell; bob funded 10,000 CKB, paid 2 fees, locked
 * profile + still-live response cell capacity.
 */
function aliceFixture() {
  const fees = [1000n, 1200n, 1500n, 900n];
  const contract = 269n * CKB;
  const profile = 3416n * CKB;
  const before = { spendable: 10_000n * CKB, total: 10_000n * CKB };
  const feeSum = fees.reduce((a, b) => a + b, 0n);
  return {
    name: "alice",
    spendableBefore: before.spendable,
    spendableAfter: before.spendable - feeSum - contract - profile,
    totalBefore: before.total,
    totalAfter: before.total - feeSum,
    fees,
    lockedCapacities: [contract, profile],
    margin: oneFeeMargin(fees),
  };
}

function bobFixture() {
  const fees = [1100n, 1400n];
  const profile = 3416n * CKB;
  const responseCell = 1793n * CKB;
  const before = { spendable: 10_000n * CKB, total: 10_000n * CKB };
  const feeSum = fees.reduce((a, b) => a + b, 0n);
  return {
    name: "bob",
    spendableBefore: before.spendable,
    spendableAfter: before.spendable - feeSum - profile - responseCell,
    totalBefore: before.total,
    totalAfter: before.total - feeSum,
    fees,
    lockedCapacities: [responseCell, profile],
    margin: oneFeeMargin(fees),
  };
}

describe("reconcileSide", () => {
  it("accepts exact expected deltas for both identities", () => {
    for (const fixture of [aliceFixture(), bobFixture()]) {
      const checks = reconcileSide(fixture);
      expect(checks.length).toBe(2);
      for (const check of checks) {
        expect(check.ok).toBe(true);
        expect(check.actual).toBe(check.expected);
      }
    }
  });

  it("accepts drift within the one-fee margin, rejects beyond it", () => {
    const fixture = aliceFixture();
    const within = { ...fixture, spendableAfter: fixture.spendableAfter + fixture.margin };
    expect(reconcileSide(within).every((c) => c.ok)).toBe(true);

    const beyond = { ...fixture, spendableAfter: fixture.spendableAfter + fixture.margin + 1n };
    const checks = reconcileSide(beyond);
    expect(checks.find((c) => c.label.includes("spendable"))!.ok).toBe(false);
    // The total-delta check is unaffected by a spendable-only drift.
    expect(checks.find((c) => c.label.includes("total"))!.ok).toBe(true);
  });

  it("detects a missing reclaim (message capacity never returned)", () => {
    const fixture = aliceFixture();
    const messageCapacity = 1793n * CKB;
    // If alice had NOT reclaimed, her spendable would be lower by the cell capacity…
    const notReclaimed = {
      ...fixture,
      spendableAfter: fixture.spendableAfter - messageCapacity,
      totalAfter: fixture.totalAfter - messageCapacity,
    };
    const checks = reconcileSide(notReclaimed);
    expect(checks.every((c) => c.ok)).toBe(false);
  });
});

describe("checkDelta / oneFeeMargin", () => {
  it("oneFeeMargin picks the largest fee", () => {
    expect(oneFeeMargin([3n, 9n, 4n])).toBe(9n);
    expect(oneFeeMargin([])).toBe(0n);
  });

  it("checkDelta bounds are inclusive", () => {
    expect(checkDelta("x", 100n, 110n, 10n).ok).toBe(true);
    expect(checkDelta("x", 100n, 90n, 10n).ok).toBe(true);
    expect(checkDelta("x", 100n, 111n, 10n).ok).toBe(false);
    expect(checkDelta("x", 100n, 89n, 10n).ok).toBe(false);
  });
});
