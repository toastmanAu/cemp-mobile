/**
 * QR module matrix for the contact bundle (spec §5.4 payload).
 *
 * Wraps `qrcode-generator` for its Reed-Solomon error correction only: a
 * wrong matrix fails in the field rather than at build time, which is not a
 * risk worth taking to save a dependency. Rendering is ours (see png.ts).
 */

import qrcode from "qrcode-generator";

export interface QrMatrix {
  /** Module count per side. */
  readonly size: number;
  /** Row-major dark flags, length `size * size`. */
  readonly dark: readonly boolean[];
}

/**
 * Error correction level M (~15% recovery). Chosen over L because a shared
 * card is expected to survive messaging-app recompression; higher levels
 * enlarge the matrix, which costs more than they recover at this payload
 * size.
 */
const ERROR_CORRECTION = "M";

export function qrMatrix(text: string): QrMatrix {
  if (text.length === 0) {
    throw new Error("qrMatrix: refusing to encode an empty payload");
  }
  // Type number 0 = pick the smallest version that fits.
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(text);
  qr.make();

  const size = qr.getModuleCount();
  const dark: boolean[] = new Array<boolean>(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      dark[row * size + col] = qr.isDark(row, col);
    }
  }
  return { size, dark };
}
