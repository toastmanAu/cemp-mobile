/**
 * Hex helpers shared by the Android platform seams (pure — no React Native
 * import, so callers stay unit-testable and there is exactly one copy of this
 * logic in the app).
 */

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Tolerates an optional `0x` prefix (chain/RPC hex) — strip, then decode. */
export function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
