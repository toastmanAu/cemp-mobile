/**
 * RN-free half of the image-codec adapter (Task 6). Split out of
 * native-image-codec.ts because that file imports `react-native` at module
 * scope, and react-native's own entrypoint uses Flow syntax that vitest's
 * transform cannot parse — importing it (even transitively, even for an
 * unused export) crashes the test run before any test executes. Keeping
 * `HandleTracker` here, with zero react-native dependency, is what makes it
 * unit-testable at all; `native-image-codec.ts` re-exports it so external
 * consumers (Task 13) can still do
 * `import { HandleTracker, NativeImageCodec } from "./native-image-codec.js"`
 * unchanged.
 */

import type { DecodedImage, ImageCodec, ImageEncodeFormat } from "@cemp/images";

/**
 * A codec whose handles can be released. `NativeImageCodec` satisfies this
 * shape; `HandleTracker` is written against the interface (not the concrete
 * class) so it stays RN-free and unit-testable with a pure fake.
 */
export type ReleasableImageCodec = ImageCodec & {
  release(handle: number): Promise<void>;
};

/**
 * Decorator that records every DISTINCT native handle produced by decode/resize
 * and releases each exactly once via `releaseAll()`. The @cemp/images pipeline
 * performs ZERO cleanup and may alias handles (e.g. a resize/compress step can
 * return its input handle unchanged), so callers wrap the codec, run
 * `prepareAttachmentChunks`, and `releaseAll()` in a `finally` — covering both
 * success and the throw path (spec §4 item 4). A Set keyed on the numeric
 * handle is what makes this aliasing-safe: an aliased handle is added once and
 * therefore released once, never double-freed.
 */
export class HandleTracker implements ImageCodec {
  readonly #inner: ReleasableImageCodec;
  readonly #handles = new Set<number>();

  constructor(inner: ReleasableImageCodec) {
    this.#inner = inner;
  }

  #track(image: DecodedImage): DecodedImage {
    if (typeof image.pixels === "number") {
      this.#handles.add(image.pixels);
    }
    return image;
  }

  async decode(bytes: Uint8Array): Promise<DecodedImage> {
    return this.#track(await this.#inner.decode(bytes));
  }

  async resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> {
    return this.#track(await this.#inner.resize(image, width, height));
  }

  async encode(image: DecodedImage, format: ImageEncodeFormat, quality: number): Promise<Uint8Array> {
    return this.#inner.encode(image, format, quality);
  }

  /** Release every distinct handle once. Best-effort: a failed release never masks the primary error. */
  async releaseAll(): Promise<void> {
    for (const handle of this.#handles) {
      try {
        await this.#inner.release(handle);
      } catch {
        // Native side recycles defensively; a leaked handle is not fatal.
      }
    }
    this.#handles.clear();
  }
}
