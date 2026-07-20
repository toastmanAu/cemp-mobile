import { describe, expect, it } from "vitest";
import { AsyncMutex } from "./async-mutex.js";

describe("AsyncMutex", () => {
  it("serializes concurrent runExclusive calls", async () => {
    const mutex = new AsyncMutex();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        mutex.runExclusive(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          order.push(i);
        }),
      ),
    );

    expect(maxActive).toBe(1);
    expect(order).toHaveLength(4);
  });

  it("releases the lock after a rejection so the next caller still runs", async () => {
    const mutex = new AsyncMutex();

    await expect(
      mutex.runExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let ran = false;
    await mutex.runExclusive(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("returns the callback's resolved value", async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(async () => 42);
    expect(result).toBe(42);
  });
});
