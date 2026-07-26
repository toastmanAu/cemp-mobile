import { describe, expect, it } from "vitest";
import type { Scheduler } from "@cemp/sync";
import type { KdfEngine, PlatformKeyStore } from "@cemp/secure-vault";
import { NoopNotifier, type Notifier } from "@cemp/ui";
import { selectSeams, type PlatformSeams, type SeamScheduler } from "./seams-core";
import type { ReleasableImageCodec } from "./handle-tracker";

/**
 * `seams.ts` (which builds the REAL per-platform seam sets) imports
 * react-native and so cannot run under vitest. These fakes stand in for the
 * two sets; what is under test is the selection decision itself.
 */
function fakeSeams(notifier: Notifier): PlatformSeams {
  const keystore: PlatformKeyStore = {
    kind: "fake",
    isAvailable: () => Promise.resolve(true),
    isBiometricAvailable: () => Promise.resolve(false),
    wrap: () => Promise.reject(new Error("fake")),
    unwrap: () => Promise.reject(new Error("fake")),
    deleteKey: () => Promise.resolve(),
  };
  const kdfEngine: KdfEngine = {
    kind: "fake",
    deriveKek: () => Promise.reject(new Error("fake")),
  };
  const scheduler: SeamScheduler = {
    schedulePeriodic: () => undefined,
    scheduleOneShot: () => undefined,
    cancel: () => undefined,
    cancelPeriodic: () => Promise.resolve(),
  };
  const imageCodec: ReleasableImageCodec = {
    decode: () => Promise.reject(new Error("fake")),
    resize: () => Promise.reject(new Error("fake")),
    encode: () => Promise.reject(new Error("fake")),
    release: () => Promise.resolve(),
  };
  return {
    createKeyStore: () => keystore,
    createNotifier: () => notifier,
    createKdfEngine: () => kdfEngine,
    createScheduler: () => scheduler,
    createImageCodec: () => imageCodec,
    requestNotificationPermission: () => Promise.resolve(),
  };
}

const ANDROID = fakeSeams({
  post: () => Promise.reject(new Error("android notifier")),
  cancel: () => Promise.resolve(),
});
const IOS = fakeSeams(new NoopNotifier());

describe("selectSeams", () => {
  it("returns the iOS seam set on ios", () => {
    expect(selectSeams("ios", ANDROID, IOS)).toBe(IOS);
  });

  it("returns the Android seam set on android", () => {
    expect(selectSeams("android", ANDROID, IOS)).toBe(ANDROID);
  });

  it("falls back to the Android set for any other platform value", () => {
    expect(selectSeams("macos", ANDROID, IOS)).toBe(ANDROID);
    expect(selectSeams("web", ANDROID, IOS)).toBe(ANDROID);
  });

  it("gives iOS the silent notifier (foreground catch-up is the v1 sync path)", () => {
    expect(selectSeams("ios", ANDROID, IOS).createNotifier()).toBeInstanceOf(NoopNotifier);
  });

  it("the iOS notification-permission request is a no-op that resolves", async () => {
    await expect(
      selectSeams("ios", ANDROID, IOS).requestNotificationPermission(),
    ).resolves.toBeUndefined();
  });

  it("factories hand the consumer a scheduler with cancelPeriodic (wipe needs it)", () => {
    const scheduler: Scheduler = selectSeams("android", ANDROID, IOS).createScheduler();
    expect(typeof (scheduler as SeamScheduler).cancelPeriodic).toBe("function");
  });
});
