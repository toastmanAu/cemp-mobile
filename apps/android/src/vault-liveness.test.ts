import { describe, expect, it } from "vitest";
import { isVaultUsable, type VaultLiveness } from "./vault-liveness";

const NOW = 1_700_000_000_000;

function liveness(overrides: Partial<VaultLiveness> = {}): VaultLiveness {
  return {
    containerReady: true,
    vaultUnlocked: true,
    autoLockDeadlineMs: NOW + 60_000,
    nowMs: NOW,
    ...overrides,
  };
}

describe("isVaultUsable", () => {
  it("accepts a ready container with a live, unexpired vault", () => {
    expect(isVaultUsable(liveness())).toBe(true);
  });

  it("rejects when the container is not ready", () => {
    expect(isVaultUsable(liveness({ containerReady: false }))).toBe(false);
  });

  it("rejects when the vault reports locked even though the container still says ready", () => {
    // The container's cached projection lags: its 1s poll was suspended while
    // the app was backgrounded, so it never observed the auto-lock.
    expect(isVaultUsable(liveness({ containerReady: true, vaultUnlocked: false }))).toBe(false);
  });

  it("rejects when the deadline has passed even though both states still say unlocked", () => {
    // The regression this whole module exists for: seven minutes backgrounded
    // against a five-minute timer. The vault's own `setTimeout` was frozen too,
    // so `vault.state` is ALSO stale at this instant — only the wall clock knows.
    expect(
      isVaultUsable(
        liveness({
          containerReady: true,
          vaultUnlocked: true,
          autoLockDeadlineMs: NOW - 7 * 60_000,
        }),
      ),
    ).toBe(false);
  });

  it("rejects exactly at the deadline", () => {
    expect(isVaultUsable(liveness({ autoLockDeadlineMs: NOW }))).toBe(false);
  });

  it("accepts one millisecond before the deadline", () => {
    expect(isVaultUsable(liveness({ autoLockDeadlineMs: NOW + 1 }))).toBe(true);
  });

  it("accepts an unlocked vault with no timer armed rather than failing closed", () => {
    expect(isVaultUsable(liveness({ autoLockDeadlineMs: null }))).toBe(true);
  });

  it("still rejects a locked vault with no timer armed", () => {
    expect(isVaultUsable(liveness({ vaultUnlocked: false, autoLockDeadlineMs: null }))).toBe(false);
  });
});
