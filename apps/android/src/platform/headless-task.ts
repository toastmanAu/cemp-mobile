/**
 * Signals headless-task completion to the app-local CempHeadlessTask Kotlin
 * module (android/app/src/main/java/com/cempmobile/background).
 *
 * React Native's own `HeadlessJsTaskSupport` module is NOT registered under the
 * New Architecture — the bridgeless `CoreReactPackage` does not list it and
 * nothing else constructs it — so `AppRegistryImpl.startHeadlessTask`'s
 * `TurboModuleRegistry.get('HeadlessJsTaskSupport')` resolves to null and its
 * `notifyTaskFinished` calls are all skipped. Every tick therefore hung until
 * the native 120s task timeout fired. We own both sides of this boundary, so we
 * signal through our own module instead.
 *
 * Imports react-native, so this file cannot run under vitest (project rule); it
 * stays a thin pass-through. The payload parsing lives in the RN-free
 * `headless-task-id.ts`, which is unit-tested directly.
 */

import { NativeModules } from "react-native";

interface CempHeadlessTaskNativeModule {
  notifyTaskFinished(tickId: number): void;
}

/**
 * Tell native this tick is over. Never throws: a failure to signal is not worth
 * failing a tick that has already done its work, and the native timeout remains
 * as the backstop if the signal cannot get through.
 */
export function notifyTaskFinished(tickId: number): void {
  try {
    const module = NativeModules.CempHeadlessTask as CempHeadlessTaskNativeModule | undefined;
    if (module === undefined) {
      console.warn(
        "[CempSync] headless finish: the CempHeadlessTask native module is not linked; " +
          "the tick will linger until the native timeout",
      );
      return;
    }
    module.notifyTaskFinished(tickId);
  } catch (error) {
    console.warn(
      `[CempSync] headless finish: signal failed — ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}
