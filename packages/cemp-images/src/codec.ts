/**
 * Image codec boundary (AGENTS.md rule 14).
 *
 * Decode/resize/encode is inherently platform-specific (native libraries on
 * Android, `sharp`-class tooling on desktop). The platform-neutral pipeline
 * (compress policy, encryption, chunking, manifests) talks only to this
 * interface; tests drive it with deterministic fakes, the Android
 * implementation ships with the device phase. Every implementation must
 * STRIP METADATA by construction: decode → re-encode never carries EXIF/GPS
 * or orientation tags across (task 2) — orientation is BAKED INTO the pixels
 * at decode time (spec §9.1 step 2), not preserved as a tag.
 */

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** Opaque to the pipeline: the codec's pixel container. */
  readonly pixels: unknown;
}

export type ImageEncodeFormat = "webp" | "jpeg";

export interface ImageCodec {
  /** Decode an encoded image (JPEG/PNG/WebP input), applying EXIF orientation. */
  decode(bytes: Uint8Array): Promise<DecodedImage>;
  /** Aspect-exact resize to explicit dimensions (computed by limits.ts). */
  resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage>;
  /** Re-encode. `quality` is 1..100. Output carries NO metadata (task 2). */
  encode(image: DecodedImage, format: ImageEncodeFormat, quality: number): Promise<Uint8Array>;
}

/** Detected raster format from magic bytes (validation after download). */
export type SniffedFormat = "jpeg" | "png" | "webp" | "unknown";

/**
 * Cheap magic-byte sniffing — the manifest's declared mime is untrusted
 * (rule 4), so the receiver checks the plaintext itself before decoding
 * (task 12 + spec §9.4 step 8 sandbox hint).
 */
export function sniffImageFormat(bytes: Uint8Array): SniffedFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "webp";
  }
  return "unknown";
}
