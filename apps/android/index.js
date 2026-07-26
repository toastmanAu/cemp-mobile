// Platform polyfills, before ANY CEMP code executes:
// - globalThis.crypto.getRandomValues: Hermes lacks it; the native CSPRNG
//   module backs cemp-crypto's only randomness source (spec §14.1).
// - TextEncoder/TextDecoder: Hermes (RN 0.83) has neither.
import "react-native-get-random-values";
import "fast-text-encoding";
import { AppRegistry } from "react-native";
import { App } from "./src/App";
import { backgroundSyncTask } from "./src/background-sync";

AppRegistry.registerComponent("CempMobile", () => App);

// The background-sync headless task registers on BOTH platforms: Android's
// WorkManager tick invokes it via HeadlessJS, and the iOS BGTaskScheduler
// bridge (CempScheduler) delivers ticks to the exact same entry via
// AppRegistry.startHeadlessTask. The task itself null-guards the container
// and signals completion through CempHeadlessTask (present on both).
AppRegistry.registerHeadlessTask("CempBackgroundSync", () => backgroundSyncTask);
