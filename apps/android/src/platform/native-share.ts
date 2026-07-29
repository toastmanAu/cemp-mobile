/**
 * Native share sheet over the app-local CempShare module.
 *
 * React Native has no filesystem API, and the share sheet needs a file URL for
 * the image. Writing the temp file natively keeps that detail on one side of
 * the bridge instead of adding a filesystem dependency for a single call.
 *
 * Imports react-native, so — per project convention (native-kdf.ts,
 * native-image-picker.ts) — it cannot run under vitest.
 */

import { NativeModules } from "react-native";
import { bytesToHex } from "./hex";

interface CempShareNativeModule {
  shareImage(pngHex: string, caption: string): Promise<void>;
}

export async function shareImage(png: Uint8Array, caption: string): Promise<void> {
  const m = NativeModules.CempShare as CempShareNativeModule | undefined;
  if (m === undefined) {
    throw new Error("shareImage: the CempShare native module is not linked");
  }
  await m.shareImage(bytesToHex(png), caption);
}
