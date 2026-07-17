/**
 * Reconciliation arithmetic (pure functions, unit-tested with fixtures; the
 * reconcile step feeds live chain data through them).
 *
 * Balance model (matches CCC's own wallet-balance filter):
 *
 *  - `spendable` — live cells under the lock with NO type script and empty
 *    data. Protocol cells (profile, message, contract) are excluded, so
 *    capacities that move into those cells leave the spendable balance.
 *  - `total` — ALL live cells under the lock. Every cell this client creates
 *    keeps its owner's lock (messages are sender-owned, rule 9), so the
 *    total only ever decreases by fees; a reclaim returns the message
 *    capacity to the sender's spendable balance.
 *
 * Hence, per identity:
 *
 *   spendable delta == -(fees + capacities locked in protocol cells)
 *   total delta    == -(fees)
 */

export interface SideInput {
  name: string;
  spendableBefore: bigint;
  spendableAfter: bigint;
  totalBefore: bigint;
  totalAfter: bigint;
  /** Every fee the identity paid (shannons). */
  fees: bigint[];
  /** Capacities that left the spendable balance: contract cell, profile cell, still-live sent message cells. */
  lockedCapacities: bigint[];
  /** Tolerance (one-fee margin). */
  margin: bigint;
}

export interface DeltaCheck {
  label: string;
  expected: bigint;
  actual: bigint;
  margin: bigint;
  ok: boolean;
}

function sum(values: bigint[]): bigint {
  return values.reduce((acc, value) => acc + value, 0n);
}

export function checkDelta(
  label: string,
  expected: bigint,
  actual: bigint,
  margin: bigint,
): DeltaCheck {
  const drift = actual - expected;
  const ok = drift >= -margin && drift <= margin;
  return { label, expected, actual, margin, ok };
}

/** Both delta checks for one identity. */
export function reconcileSide(side: SideInput): DeltaCheck[] {
  const feeSum = sum(side.fees);
  const lockedSum = sum(side.lockedCapacities);
  return [
    checkDelta(
      `${side.name} spendable delta`,
      -(feeSum + lockedSum),
      side.spendableAfter - side.spendableBefore,
      side.margin,
    ),
    checkDelta(
      `${side.name} total delta`,
      -feeSum,
      side.totalAfter - side.totalBefore,
      side.margin,
    ),
  ];
}

/** Largest fee as the one-fee margin; falls back to a floor for degenerate inputs. */
export function oneFeeMargin(fees: bigint[]): bigint {
  let max = 0n;
  for (const fee of fees) {
    if (fee > max) {
      max = fee;
    }
  }
  return max;
}
