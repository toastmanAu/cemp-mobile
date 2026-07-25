import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_PER_CHUNK_SHANNON,
  estimateImageSendShannon,
  hasSufficientCapacity,
  SEND_FEE_RESERVE_SHANNONS,
} from "./capacity.js";

describe("image send capacity", () => {
  it("sums chunk cells + message cell + fee reserve", () => {
    const required = estimateImageSendShannon({
      chunkCount: 4,
      perChunkShannon: 33_000n * 100_000_000n,
      messageCellShannon: 20_000n * 100_000_000n,
      feeReserveShannon: SEND_FEE_RESERVE_SHANNONS,
    });
    expect(required).toBe(
      4n * (33_000n * 100_000_000n) + 20_000n * 100_000_000n + SEND_FEE_RESERVE_SHANNONS,
    );
  });

  it("blocks when balance is below required", () => {
    expect(hasSufficientCapacity(10n, 11n)).toBe(false);
    expect(hasSufficientCapacity(11n, 11n)).toBe(true);
  });

  it("exposes a conservative per-chunk upper bound covering a full 32 KiB cell", () => {
    // A full chunk cell locks ~its own byte size in CKB; the constant must be
    // an UPPER bound so the pre-flight never false-negatives an affordable send.
    expect(CONSERVATIVE_PER_CHUNK_SHANNON).toBeGreaterThanOrEqual(32_768n * 100_000_000n);
  });
});
