/**
 * QR module matrix for the contact bundle (spec §5.4 payload).
 *
 * Wraps `qrcode-generator` for its Reed-Solomon error correction only: a
 * wrong matrix fails in the field rather than at build time, which is not a
 * risk worth taking to save a dependency. Rendering is ours (see png.ts).
 *
 * Constraint: `qrcode-generator`'s byte encoder is `charCodeAt(i) & 0xff` —
 * Latin-1 truncation, not UTF-8. Encoding non-ASCII text would silently
 * produce a matrix that scans perfectly and decodes as mojibake, which is
 * exactly the "fails in the field, not at build time" risk this file exists
 * to avoid — so {@link qrMatrix} rejects non-printable-ASCII input up front
 * instead of passing it through.
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

/** Printable ASCII only (0x20-0x7e) — see the Latin-1 constraint above. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** `qrcode-generator` throws bare strings, not `Error`s. Normalize both. */
function asError(e: unknown): Error {
  if (e instanceof Error) {
    return e;
  }
  return new Error(typeof e === "string" ? e : String(e));
}

export function qrMatrix(text: string): QrMatrix {
  if (text.length === 0) {
    throw new Error("qrMatrix: refusing to encode an empty payload");
  }
  if (!PRINTABLE_ASCII.test(text)) {
    throw new Error(
      "qrMatrix: payload must be printable ASCII — qrcode-generator's byte " +
        "encoder is Latin-1 (charCodeAt & 0xff), not UTF-8, so non-ASCII " +
        "input would silently encode to a scannable but corrupted matrix",
    );
  }

  let qr: ReturnType<typeof qrcode>;
  try {
    // Type number 0 = pick the smallest version that fits.
    qr = qrcode(0, ERROR_CORRECTION);
    qr.addData(text);
    qr.make();
  } catch (e) {
    throw new Error(`qrMatrix: qrcode-generator failed: ${asError(e).message}`, { cause: e });
  }

  const size = qr.getModuleCount();
  const dark: boolean[] = new Array<boolean>(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      dark[row * size + col] = qr.isDark(row, col);
    }
  }
  return { size, dark };
}
