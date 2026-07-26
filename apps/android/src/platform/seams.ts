/**
 * Platform seams for the composition root — the one place that decides which
 * platform implementations back the app's service boundaries. Both branches
 * must stay import-safe on BOTH platforms: Metro bundles the whole module
 * regardless of `Platform.OS`, so no branch may require a native module at
 * import time (the bridge classes below all look up `NativeModules` lazily).
 *
 * Imports react-native, so this file cannot run under vitest; the selection
 * logic lives in the RN-free `seams-core.ts`, where it is unit-tested.
 */

import { Platform } from "react-native";
import { NoopNotifier } from "@cemp/ui";
import { AndroidKeychainKeyStore } from "./android-keystore";
import { AndroidNotifier, requestNotificationPermission } from "./android-notifier";
import { NativeImageCodec } from "./native-image-codec";
import { NativeKdfEngine } from "./native-kdf";
import { WorkManagerScheduler } from "./work-manager-scheduler";
import { selectSeams, type PlatformSeams } from "./seams-core";

const ANDROID_SEAMS: PlatformSeams = {
  createKeyStore: () => new AndroidKeychainKeyStore(),
  createNotifier: () => new AndroidNotifier(),
  createKdfEngine: () => new NativeKdfEngine(),
  createScheduler: () => new WorkManagerScheduler(),
  createImageCodec: () => new NativeImageCodec(),
  requestNotificationPermission,
};

/**
 * iOS v1. The keystore, KDF engine, image codec and scheduler are the SAME
 * JS classes as Android's: react-native-keychain is cross-platform, and the
 * CempKdf / CempImageCodec / CempScheduler native iOS modules mirror the
 * Android bridge contracts (same NativeModules names and methods), so the
 * existing bridge classes work unchanged. The two deliberate differences:
 *
 * - Notifier is NoopNotifier. There is no iOS notification bridge yet, and
 *   foreground catch-up is the primary sync path on iOS v1 — the BGTask tick
 *   is best-effort and far less frequent than WorkManager's — so nothing
 *   posts user-visible notifications until a CempNotifier iOS module exists.
 * - requestNotificationPermission is a no-op: POST_NOTIFICATIONS is an
 *   Android 13+ runtime grant; with no iOS notifier there is no permission
 *   to ask for.
 */
const IOS_SEAMS: PlatformSeams = {
  createKeyStore: () => new AndroidKeychainKeyStore(),
  createNotifier: () => new NoopNotifier(),
  createKdfEngine: () => new NativeKdfEngine(),
  createScheduler: () => new WorkManagerScheduler(),
  createImageCodec: () => new NativeImageCodec(),
  requestNotificationPermission: () => Promise.resolve(),
};

/** The seam set for the platform this process is running on. */
export function platformSeams(): PlatformSeams {
  return selectSeams(Platform.OS, ANDROID_SEAMS, IOS_SEAMS);
}
