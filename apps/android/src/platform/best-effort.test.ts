import { describe, expect, it, vi } from "vitest";
import { bestEffort } from "./best-effort";

describe("bestEffort", () => {
  it("resolves normally when the operation succeeds", async () => {
    const op = vi.fn().mockResolvedValue(undefined);
    await expect(bestEffort(op)).resolves.toBeUndefined();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected promise instead of propagating it", async () => {
    const op = vi.fn().mockRejectedValue(new Error("native call failed"));
    await expect(bestEffort(op)).resolves.toBeUndefined();
  });

  it("swallows a synchronous throw from the operation", async () => {
    const op = vi.fn(() => {
      throw new Error("native module not linked");
    });
    await expect(bestEffort(op)).resolves.toBeUndefined();
  });
});
