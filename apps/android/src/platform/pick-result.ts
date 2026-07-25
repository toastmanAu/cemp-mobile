/**
 * RN-free half of the image picker adapter (Task 7). Split out of
 * native-image-picker.ts because that file imports `react-native` at module
 * scope, and react-native's own entrypoint uses Flow syntax that vitest's
 * transform cannot parse — importing it (even transitively, even for an
 * unused export) crashes the test run before any test executes. Keeping
 * `decodePickResult` here, with zero react-native dependency, is what makes it
 * unit-testable at all; `native-image-picker.ts` re-exports it so external
 * consumers (Task 15) can still do `import { pickImage } from "./native-image-picker.js"`
 * unchanged.
 */

import { hexToBytes } from "./hex";

/**
 * Decode the native picker result: hex string → Uint8Array, or null on cancel.
 * This encodes the cancel semantics (spec §4 item 2): null from native means
 * the user cancelled the picker and we return null to the caller.
 */
export function decodePickResult(hex: string | null): Uint8Array | null {
  return hex === null ? null : hexToBytes(hex);
}
