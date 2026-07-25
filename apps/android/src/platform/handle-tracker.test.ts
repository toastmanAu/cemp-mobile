/**
 * Unit tests for the aliasing-safe HandleTracker (Task 6, spec §4 item 4).
 *
 * Deliberately drives HandleTracker with a PURE FAKE `ReleasableImageCodec`
 * (no react-native, no mocking framework needed) rather than the brief's
 * `vi.mock("react-native")` approach: this repo has no react-native
 * test-mocking infrastructure, and — as proven while implementing this task
 * — importing anything that pulls in the real "react-native" package crashes
 * vitest outright (its entrypoint uses Flow syntax the transform can't
 * parse). The thin NativeImageCodec bridge itself is intentionally
 * untested here; per repo convention (native-kdf.ts, android-notifier.ts) it
 * is device/compile-verified only.
 */

import { describe, expect, it } from "vitest";
import type { DecodedImage, ImageEncodeFormat } from "@cemp/images";
import { HandleTracker, type ReleasableImageCodec } from "./handle-tracker.js";

/** In-memory fake standing in for the native bridge. Assigns sequential handles. */
function createFakeCodec(): ReleasableImageCodec & { releaseCalls: number[] } {
  const releaseCalls: number[] = [];
  let nextHandle = 1;

  return {
    releaseCalls,
    async decode(_bytes: Uint8Array): Promise<DecodedImage> {
      return { width: 10, height: 10, pixels: nextHandle++ };
    },
    async resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> {
      return { width, height, pixels: image.pixels };
    },
    async encode(
      _image: DecodedImage,
      _format: ImageEncodeFormat,
      _quality: number,
    ): Promise<Uint8Array> {
      return new Uint8Array([0xff, 0xd8, 0xff]);
    },
    async release(handle: number): Promise<void> {
      releaseCalls.push(handle);
    },
  };
}

describe("HandleTracker", () => {
  it("release-on-error: releases every DISTINCT handle exactly once when encode throws (aliasing-safe)", async () => {
    const inner = createFakeCodec();
    // Force the aliasing + throw scenario explicitly rather than relying on
    // the fake's default sequential-handle behavior.
    let resizeCall = 0;
    inner.resize = async (image: DecodedImage, width: number, height: number) => {
      resizeCall += 1;
      // First resize -> a NEW handle (2). Second resize -> aliases the
      // original decode handle (1), simulating a compress step that hands
      // back its input unchanged.
      return resizeCall === 1
        ? { width, height, pixels: 2 }
        : { width, height, pixels: image.pixels };
    };
    inner.encode = async () => {
      throw new Error("boom");
    };

    const tracker = new HandleTracker(inner);
    const a = await tracker.decode(new Uint8Array([9])); // handle 1
    expect(a.pixels).toBe(1);

    await tracker.resize(a, 8, 8); // handle 2
    await tracker.resize(a, 10, 10); // alias of handle 1

    await expect(tracker.encode(a, "webp", 50)).rejects.toThrow("boom");
    await tracker.releaseAll();

    // Distinct handles {1, 2} each released exactly once — NOT [1, 1, 2],
    // which is what a naive array-of-handles (no dedup) would produce.
    const released = [...inner.releaseCalls].sort((x, y) => x - y);
    expect(released).toEqual([1, 2]);
  });

  it("happy path: releases each tracked handle once and clears state", async () => {
    const inner = createFakeCodec();
    const tracker = new HandleTracker(inner);

    const decoded1 = await tracker.decode(new Uint8Array([1])); // handle 1 (default fake: sequential)
    const decoded2 = await tracker.decode(new Uint8Array([2])); // handle 2
    const out = await tracker.encode(decoded2, "jpeg", 90);

    expect(Array.from(out)).toEqual([0xff, 0xd8, 0xff]);
    expect(decoded1.pixels).toBe(1);
    expect(decoded2.pixels).toBe(2);

    await tracker.releaseAll();

    const released = [...inner.releaseCalls].sort((x, y) => x - y);
    expect(released).toEqual([1, 2]);

    // releaseAll clears internal state: a second call releases nothing more.
    await tracker.releaseAll();
    expect(inner.releaseCalls).toEqual([1, 2]);
  });
});
