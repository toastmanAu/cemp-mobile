/**
 * Pure base64 encoder (standard alphabet, `=` padding) — RN-free so it stays
 * unit-testable. There is no `Buffer`/`btoa` guaranteed available under
 * Hermes, and the repo had no base64 helper yet (only `hex.ts`). Used by the
 * chat screen to build `data:<mime>;base64,<b64>` URIs for `<Image>`.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const fullGroups = Math.floor(bytes.length / 3) * 3;

  for (let i = 0; i < fullGroups; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += ALPHABET[b2 & 0x3f];
  }

  const remainder = bytes.length - fullGroups;
  if (remainder === 1) {
    const b0 = bytes[fullGroups]!;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[(b0 & 0x03) << 4];
    out += "==";
  } else if (remainder === 2) {
    const b0 = bytes[fullGroups]!;
    const b1 = bytes[fullGroups + 1]!;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += ALPHABET[(b1 & 0x0f) << 2];
    out += "=";
  }

  return out;
}
