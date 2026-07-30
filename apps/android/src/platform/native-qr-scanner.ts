/**
 * QR decoding over the app-local CempQrScanner module.
 *
 * Decoding is native because the JS side never receives raw pixels: the image
 * codec hands back an opaque native bitmap handle by design, so a JS decoder
 * would mean bridging megabytes of RGBA as hex (see the design doc's rejected
 * alternative).
 *
 * Imports react-native, so — per project convention (native-kdf.ts,
 * native-share.ts) — it cannot run under vitest.
 */

import { NativeModules } from "react-native";
import { bytesToHex } from "./hex";

interface CempQrScannerNativeModule {
  /** Decode a still image. Resolves the QR text, or null when none is found. */
  scanImage(bytesHex: string): Promise<string | null>;
  /** Present the native camera scanner. Resolves the QR text, or null on cancel. */
  scanWithCamera(): Promise<string | null>;
}

function module(): CempQrScannerNativeModule {
  const m = NativeModules.CempQrScanner as CempQrScannerNativeModule | undefined;
  if (m === undefined) {
    throw new Error("native-qr-scanner: the CempQrScanner native module is not linked");
  }
  return m;
}

export async function scanImageForQr(bytes: Uint8Array): Promise<string | null> {
  return await module().scanImage(bytesToHex(bytes));
}

export async function scanWithCamera(): Promise<string | null> {
  return await module().scanWithCamera();
}
