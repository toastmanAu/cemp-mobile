// Platform polyfills, before ANY CEMP code executes:
// - globalThis.crypto.getRandomValues: Hermes lacks it; the native CSPRNG
//   module backs cemp-crypto's only randomness source (spec §14.1).
// - TextEncoder/TextDecoder: Hermes (RN 0.83) has neither.
import "react-native-get-random-values";
import "fast-text-encoding";
import { AppRegistry } from "react-native";
import { App } from "./src/App";

AppRegistry.registerComponent("CempMobile", () => App);
