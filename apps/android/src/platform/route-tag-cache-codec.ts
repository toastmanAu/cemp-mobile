/**
 * Codec for the locked-mode route-tag cache (Phase 9 design D2).
 *
 * The cache holds ONLY derived route tags — never the profile id, which would
 * let a reader derive every epoch's tag. `lastSeen` carries the outpoints the
 * probe has already notified about, so a repeat tick stays silent.
 *
 * Pure: no React Native imports, so it is unit-tested directly.
 */

export interface TagCache {
  /** Hex route tags (previous, current, next epoch). */
  readonly tags: readonly string[];
  /** `txHash:index` of outpoints already notified about. */
  readonly lastSeen: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function encodeTagCache(cache: TagCache): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ tags: [...cache.tags], lastSeen: [...cache.lastSeen] }),
  );
}

export function decodeTagCache(bytes: Uint8Array): TagCache {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("route-tag-cache: blob is not an object");
  }
  const { tags, lastSeen } = parsed as { tags?: unknown; lastSeen?: unknown };
  if (!isStringArray(tags) || !isStringArray(lastSeen)) {
    throw new Error("route-tag-cache: tags and lastSeen must be string arrays");
  }
  return { tags, lastSeen };
}

/** Outpoints in `current` that `lastSeen` does not already contain. */
export function newOutpoints(lastSeen: readonly string[], current: readonly string[]): string[] {
  const seen = new Set(lastSeen);
  return current.filter((outpoint) => !seen.has(outpoint));
}
