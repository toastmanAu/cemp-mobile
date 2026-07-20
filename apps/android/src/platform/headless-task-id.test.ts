import { describe, expect, it } from "vitest";
import { tickIdFrom } from "./headless-task-id";

describe("tickIdFrom", () => {
  it("reads the tick id the native worker put in the payload", () => {
    expect(tickIdFrom({ tickId: 1 })).toBe(1);
    expect(tickIdFrom({ tickId: 4321 })).toBe(4321);
  });

  it("ignores other keys in the payload", () => {
    expect(tickIdFrom({ tickId: 7, somethingElse: "x" })).toBe(7);
  });

  it("returns null when there is no payload at all", () => {
    expect(tickIdFrom(undefined)).toBeNull();
    expect(tickIdFrom(null)).toBeNull();
  });

  it("returns null when the payload carries no tick id", () => {
    expect(tickIdFrom({})).toBeNull();
  });

  it("returns null for a tick id of the wrong type", () => {
    expect(tickIdFrom({ tickId: "3" })).toBeNull();
    expect(tickIdFrom({ tickId: true })).toBeNull();
    expect(tickIdFrom({ tickId: null })).toBeNull();
  });

  it("rejects non-integer and out-of-range ids", () => {
    // AtomicInteger.incrementAndGet() starts at 1, so 0 and negatives are
    // never legitimate and must not be signalled against.
    expect(tickIdFrom({ tickId: 0 })).toBeNull();
    expect(tickIdFrom({ tickId: -1 })).toBeNull();
    expect(tickIdFrom({ tickId: 1.5 })).toBeNull();
    expect(tickIdFrom({ tickId: Number.NaN })).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(tickIdFrom(42)).toBeNull();
    expect(tickIdFrom("tickId=1")).toBeNull();
  });
});
