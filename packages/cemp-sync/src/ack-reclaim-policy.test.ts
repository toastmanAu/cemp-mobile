import { describe, expect, it } from "vitest";

import { ACK_RECLAIM_FALLBACK_MS, shouldReclaimAck } from "./ack-reclaim-policy.js";

const COMMITTED = 1_700_000_000_000;

describe("shouldReclaimAck (ADR 0008)", () => {
  it("reclaims as soon as the sender has provably consumed the ack", () => {
    expect(
      shouldReclaimAck({ senderConsumedAck: true, ackCommittedAtMs: COMMITTED, nowMs: COMMITTED }),
    ).toBe(true);
  });

  it("keeps a fresh ack the sender has not consumed", () => {
    expect(
      shouldReclaimAck({
        senderConsumedAck: false,
        ackCommittedAtMs: COMMITTED,
        nowMs: COMMITTED + ACK_RECLAIM_FALLBACK_MS - 1,
      }),
    ).toBe(false);
  });

  it("falls back to reclaiming once the ack is exactly the fallback age", () => {
    expect(
      shouldReclaimAck({
        senderConsumedAck: false,
        ackCommittedAtMs: COMMITTED,
        nowMs: COMMITTED + ACK_RECLAIM_FALLBACK_MS,
      }),
    ).toBe(true);
  });

  it("never reclaims on age when the clock reads earlier than the commit (skew)", () => {
    expect(
      shouldReclaimAck({
        senderConsumedAck: false,
        ackCommittedAtMs: COMMITTED,
        nowMs: COMMITTED - ACK_RECLAIM_FALLBACK_MS * 2,
      }),
    ).toBe(false);
  });

  it("the fallback is generous: at least 30 days", () => {
    expect(ACK_RECLAIM_FALLBACK_MS).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });
});
