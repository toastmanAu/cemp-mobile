/**
 * System "Bold text" adjustment over the app-local CempTextWeight module
 * (Android 12+). iOS has no such module and no draw/measure mismatch, so a
 * missing module means "no adjustment" rather than an error.
 *
 * Imports react-native, so — per project convention (native-share.ts) — it
 * cannot run under vitest; the arithmetic lives in font-weight.ts.
 */

import { NativeModules } from "react-native";
import { normaliseFontWeightAdjustment } from "./font-weight";

interface CempTextWeightNativeModule {
  getFontWeightAdjustment(): Promise<number>;
}

export async function readFontWeightAdjustment(): Promise<number> {
  const m = NativeModules.CempTextWeight as CempTextWeightNativeModule | undefined;
  if (m === undefined) return 0;
  return normaliseFontWeightAdjustment(await m.getFontWeightAdjustment());
}
