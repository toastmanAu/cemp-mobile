/**
 * Native {@link pickImage} over the app-local CempImagePicker Kotlin module
 * (android/app/src/main/java/com/cempmobile/picker).
 *
 * The picker is the system Photo Picker (Activity Result Contracts), launched
 * by the native bridge and resolved to image bytes by the Kotlin module.
 * This is the thin JS bridge; the heavy lifting (file I/O, type detection) is
 * native. Consumed by Task 15 (attachment UI).
 */

import { NativeModules } from "react-native";
import { decodePickResult } from "./pick-result";

interface CempImagePickerNativeModule {
  /** Launch the system Photo Picker. Resolves image bytes as hex, or null on cancel. */
  pick(): Promise<string | null>;
}

export async function pickImage(): Promise<Uint8Array | null> {
  const m = NativeModules.CempImagePicker as CempImagePickerNativeModule | undefined;
  if (m === undefined) {
    throw new Error("pickImage: the CempImagePicker native module is not linked");
  }
  const hex = await m.pick();
  return decodePickResult(hex);
}
