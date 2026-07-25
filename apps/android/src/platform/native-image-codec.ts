/**
 * Native {@link ImageCodec} over the app-local CempImageCodec Kotlin module
 * (android/app/src/main/java/com/cempmobile/imaging — Task 8 must match this
 * bridge contract). `DecodedImage.pixels` carries the native bitmap handle
 * (int); the JS side never touches raw pixels, only the opaque handle.
 *
 * Imports react-native, so — per project convention (native-kdf.ts,
 * android-notifier.ts) — this thin bridge class is NOT unit-tested; it is
 * device/compile-verified only. `HandleTracker` lives in the sibling RN-free
 * `handle-tracker.ts` (imported here and re-exported) so it CAN be unit-tested
 * against a pure fake — see handle-tracker.test.ts. Splitting it out is
 * required, not stylistic: react-native's own entrypoint contains Flow syntax
 * vitest cannot parse, so any module that imports "react-native" — even
 * transitively, even for an export the test never touches — crashes the test
 * run before a single test executes.
 */

import { NativeModules } from "react-native";
import type { DecodedImage, ImageCodec, ImageEncodeFormat } from "@cemp/images";
import { bytesToHex, hexToBytes } from "./hex";

export { HandleTracker } from "./handle-tracker";
export type { ReleasableImageCodec } from "./handle-tracker";

interface DecodeResult {
  handle: number;
  width: number;
  height: number;
}

interface CempImageCodecNativeModule {
  decode(bytesHex: string): Promise<DecodeResult>;
  resize(handle: number, width: number, height: number): Promise<DecodeResult>;
  encode(handle: number, format: ImageEncodeFormat, quality: number): Promise<string>;
  release(handle: number): Promise<void>;
}

/** Bridge-backed codec. `DecodedImage.pixels` carries the native bitmap handle (int). */
export class NativeImageCodec implements ImageCodec {
  #module(): CempImageCodecNativeModule {
    const m = NativeModules.CempImageCodec as CempImageCodecNativeModule | undefined;
    if (m === undefined) {
      throw new Error("NativeImageCodec: the CempImageCodec native module is not linked");
    }
    return m;
  }

  async decode(bytes: Uint8Array): Promise<DecodedImage> {
    const r = await this.#module().decode(bytesToHex(bytes));
    return { width: r.width, height: r.height, pixels: r.handle };
  }

  async resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> {
    const r = await this.#module().resize(image.pixels as number, width, height);
    return { width: r.width, height: r.height, pixels: r.handle };
  }

  async encode(
    image: DecodedImage,
    format: ImageEncodeFormat,
    quality: number,
  ): Promise<Uint8Array> {
    return hexToBytes(await this.#module().encode(image.pixels as number, format, quality));
  }

  async release(handle: number): Promise<void> {
    await this.#module().release(handle);
  }
}
