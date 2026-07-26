/**
 * Platform seam selection (ios-prep Task 2/4 follow-through).
 *
 * RN-free half of `seams.ts`: the types the composition root consumes and the
 * pure `selectSeams(os, …)` decision, split out so the selection logic is
 * unit-testable under vitest. `seams.ts` imports `react-native` (`Platform`)
 * and the bridge classes, which crashes vitest before a single test runs
 * (see native-image-codec.ts for the standing explanation of this split).
 */

import type { Scheduler } from "@cemp/sync";
import type { KdfEngine, PlatformKeyStore } from "@cemp/secure-vault";
import type { Notifier } from "@cemp/ui";
import type { ReleasableImageCodec } from "./handle-tracker";

/**
 * The scheduler the composition root needs: the sync engine's `Scheduler`
 * plus `cancelPeriodic`, which `AppContainer.wipe()` awaits so no background
 * tick survives a factory wipe. `WorkManagerScheduler` satisfies this shape;
 * the iOS BGTaskScheduler bridge mirrors the same `NativeModules.CempScheduler`
 * contract, so the same JS class backs both platforms.
 */
export interface SeamScheduler extends Scheduler {
  cancelPeriodic(): Promise<void>;
}

/**
 * The platform-specific pieces of the composition root, behind factories so
 * each consumer gets a fresh instance exactly as it did before the seams
 * module existed (e.g. `AppContainer` builds a new scheduler for the engine
 * and another for `wipe()`).
 */
export interface PlatformSeams {
  readonly createKeyStore: () => PlatformKeyStore;
  readonly createNotifier: () => Notifier;
  readonly createKdfEngine: () => KdfEngine;
  readonly createScheduler: () => SeamScheduler;
  readonly createImageCodec: () => ReleasableImageCodec;
  readonly requestNotificationPermission: () => Promise<void>;
}

/**
 * Pick the seam set for the running platform.
 *
 * iOS is the only divergent platform today; every other value — including
 * `"android"` — gets the Android set, which is the historical behavior.
 */
export function selectSeams(os: string, android: PlatformSeams, ios: PlatformSeams): PlatformSeams {
  return os === "ios" ? ios : android;
}
