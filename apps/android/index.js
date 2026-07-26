// Platform polyfills, before ANY CEMP code executes:
// - globalThis.crypto.getRandomValues: Hermes lacks it; the native CSPRNG
//   module backs cemp-crypto's only randomness source (spec §14.1).
// - TextEncoder/TextDecoder: Hermes (RN 0.83) has neither.
import "react-native-get-random-values";
import "fast-text-encoding";
import { AppRegistry, Platform } from "react-native";
import { App } from "./src/App";
import { backgroundSyncTask } from "./src/background-sync";

AppRegistry.registerComponent("CempMobile", () => App);

// HeadlessJS is Android-only. The iOS BGTaskScheduler bridge (CempScheduler)
// delivers ticks through its own path, so there is no headless task to
// register on iOS.
if (Platform.OS === "android") {
  AppRegistry.registerHeadlessTask("CempBackgroundSync", () => backgroundSyncTask);
}
