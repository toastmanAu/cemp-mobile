/**
 * Contact bundle → shareable QR PNG.
 *
 * The QR carries the bundle and NOTHING else: the display name travels in the
 * share caption, so a forwarded image never leaks a name the sender did not
 * intend to attach (design decision, 2026-07-29).
 */

import { type ContactBundleV1, encodeContactBundle } from "../contact-bundle.js";
import { qrMatrix } from "./matrix.js";
import { encodeGreyscalePng } from "./png.js";

export interface ContactCardPngOptions {
  /** Physical pixels per QR module. Larger survives recompression better. */
  readonly modulePixels?: number;
  /** White margin in modules. The QR spec requires at least 4. */
  readonly quietModules?: number;
}

const DEFAULT_MODULE_PIXELS = 8;
const DEFAULT_QUIET_MODULES = 4;

const WHITE = 255;
const BLACK = 0;

export function contactCardPng(
  bundle: ContactBundleV1,
  opts: ContactCardPngOptions = {},
): Uint8Array {
  const modulePixels = opts.modulePixels ?? DEFAULT_MODULE_PIXELS;
  const quietModules = opts.quietModules ?? DEFAULT_QUIET_MODULES;
  if (!Number.isInteger(modulePixels) || modulePixels < 1) {
    throw new Error("contactCardPng: modulePixels must be a positive integer");
  }
  if (!Number.isInteger(quietModules) || quietModules < 4) {
    throw new Error("contactCardPng: quietModules must be at least 4 (QR spec)");
  }

  const matrix = qrMatrix(encodeContactBundle(bundle));
  const sideModules = matrix.size + quietModules * 2;
  const side = sideModules * modulePixels;

  const pixels = new Uint8Array(side * side).fill(WHITE);
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.dark[row * matrix.size + col]) {
        continue;
      }
      const originY = (row + quietModules) * modulePixels;
      const originX = (col + quietModules) * modulePixels;
      for (let dy = 0; dy < modulePixels; dy++) {
        pixels.fill(
          BLACK,
          (originY + dy) * side + originX,
          (originY + dy) * side + originX + modulePixels,
        );
      }
    }
  }

  return encodeGreyscalePng(pixels, side, side);
}
