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
  /**
   * Present the native camera scanner. Resolves the QR text, or null on a
   * plain cancel (Cancel button, no usable camera). Rejects with code
   * "qr-permission-denied" when the camera permission is denied or
   * restricted — see {@link scanWithCamera} for how this is surfaced.
   */
  scanWithCamera(): Promise<string | null>;
}

/**
 * Thrown by {@link scanWithCamera} when the camera permission is denied or
 * restricted, so the screen can show an honest message naming the
 * permission (spec's error-handling table) instead of treating it as a
 * silent cancel. Kept distinct from a plain cancel (still resolved as
 * `null`) on both platforms — Android's `QrScannerActivity` and iOS's
 * `CempQrScannerViewController` each finish/reject their own denial paths
 * with the native code this maps from.
 */
export class CameraPermissionDeniedError extends Error {
  constructor() {
    super("camera permission was denied");
    this.name = "CameraPermissionDeniedError";
  }
}

function module(): CempQrScannerNativeModule {
  const m = NativeModules.CempQrScanner as CempQrScannerNativeModule | undefined;
  if (m === undefined) {
    throw new Error("native-qr-scanner: the CempQrScanner native module is not linked");
  }
  return m;
}

/** True for the shape RN's bridge gives a rejected promise: an Error with a `code` string. */
function isPermissionDeniedRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "qr-permission-denied"
  );
}

export async function scanImageForQr(bytes: Uint8Array): Promise<string | null> {
  return await module().scanImage(bytesToHex(bytes));
}

export async function scanWithCamera(): Promise<string | null> {
  try {
    return await module().scanWithCamera();
  } catch (error: unknown) {
    if (isPermissionDeniedRejection(error)) {
      throw new CameraPermissionDeniedError();
    }
    throw error;
  }
}
