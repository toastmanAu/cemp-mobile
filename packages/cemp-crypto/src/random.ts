/**
 * Cryptographically secure randomness via `crypto.getRandomValues` — the only
 * CSPRNG source in this package. `getRandomValues` is available in Node ≥ 19,
 * browsers and Hermes/React Native; Node's `crypto` module is deliberately
 * NOT used so this code runs identically under Hermes.
 */

/** getRandomValues fills at most 65,536 bytes per call (Web Crypto spec). */
const MAX_GET_RANDOM_VALUES_BYTES = 65_536;

/** Maximum random padding length for CempPayloadV1.padding (spec §8). */
export const MAX_PADDING_BYTES = 255;

interface GetRandomValues {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function cryptoApi(): GetRandomValues {
  const api = (globalThis as { crypto?: GetRandomValues }).crypto;
  if (api === undefined || typeof api.getRandomValues !== "function") {
    throw new Error(
      "randomBytes: globalThis.crypto.getRandomValues is not available on this platform",
    );
  }
  return api;
}

/** `length` cryptographically secure random bytes (0–65,536 per call). */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > MAX_GET_RANDOM_VALUES_BYTES) {
    throw new Error(
      `randomBytes: length ${String(length)} out of range (0..${MAX_GET_RANDOM_VALUES_BYTES})`,
    );
  }
  const out = new Uint8Array(length);
  cryptoApi().getRandomValues(out);
  return out;
}

/**
 * Random padding for `CempPayloadV1.padding` (spec §8: 0–255 random bytes;
 * the v1 size-obfuscation mitigation, spec §15). Length is uniform in
 * [0, 255] and the contents are random.
 */
export function randomPadding(): Uint8Array {
  return randomBytes(randomBytes(1)[0]!);
}
