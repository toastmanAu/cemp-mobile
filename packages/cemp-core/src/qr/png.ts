/**
 * Minimal 8-bit greyscale PNG writer.
 *
 * Hand-rolled rather than taken from a dependency because the failure mode is
 * loud: a malformed PNG fails immediately and visibly, so a bug cannot hide.
 * (Contrast qr/matrix.ts, where wrong error correction would produce a code
 * that looks perfect and fails only in the field.)
 *
 * The zlib stream uses STORED (uncompressed) deflate blocks, which are valid
 * deflate and need no compressor. A QR PNG is a few hundred KB uncompressed —
 * irrelevant for a share sheet, and worth it to avoid a zlib dependency.
 */

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_STORED_BLOCK = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

/** zlib stream over STORED deflate blocks (no compression, no dependency). */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < raw.length; offset += MAX_STORED_BLOCK) {
    const slice = raw.subarray(offset, Math.min(offset + MAX_STORED_BLOCK, raw.length));
    const isFinal = offset + slice.length >= raw.length;
    const len = slice.length;
    parts.push(
      new Uint8Array([
        isFinal ? 1 : 0,
        len & 0xff,
        (len >>> 8) & 0xff,
        ~len & 0xff,
        (~len >>> 8) & 0xff,
      ]),
      slice,
    );
  }
  parts.push(u32(adler32(raw)));
  return concat(parts);
}

export function encodeGreyscalePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  if (width <= 0 || height <= 0) {
    throw new Error("encodeGreyscalePng: dimensions must be positive");
  }
  if (pixels.length !== width * height) {
    throw new Error(
      `encodeGreyscalePng: pixel length ${pixels.length} does not match ${width}x${height}`,
    );
  }

  // Each scanline is prefixed with filter type 0 (None).
  const raw = new Uint8Array((width + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width + 1)] = 0;
    raw.set(pixels.subarray(row * width, (row + 1) * width), row * (width + 1) + 1);
  }

  const ihdr = concat([
    u32(width),
    u32(height),
    new Uint8Array([8, 0, 0, 0, 0]), // bit depth 8, greyscale, deflate, adaptive filter, no interlace
  ]);

  return concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
