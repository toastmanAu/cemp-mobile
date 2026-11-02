import { describe, expect, it } from "vitest";
import { onceAsync } from "./once-async";

/**
 * AppContainer.init() must be process-scoped: Android can recreate the
 * activity (Bold text / font change, restore) while the JS runtime lives on,
 * which remounts <App/>. A second init used to build a SECOND container and
 * orphan the first one still unlocked (key in memory, DB open, sync running).
 */
describe("onceAsync", () => {
  it("runs the factory once and hands every caller the same result", async () => {
    let calls = 0;
    const init = onceAsync(async () => ({ id: ++calls }));
    const [a, b] = await Promise.all([init(), init()]);
    const c = await init();
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  it("forgets a failure so the next call can retry", async () => {
    let calls = 0;
    const init = onceAsync(async () => {
      calls += 1;
      if (calls === 1) throw new Error("keystore unavailable");
      return "ok";
    });
    await expect(init()).rejects.toThrow("keystore unavailable");
    await expect(init()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});
