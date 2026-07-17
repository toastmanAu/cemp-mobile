import { blake2b } from "@noble/hashes/blake2.js";

const textEncoder = new TextEncoder();

/** CKB-compatible BLAKE2b-256 (spec §14.1). */
export function ckbHash(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Lexicographic byte-order comparison (negative when `a < b`). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** Domain strings for identity derivation (spec §6.1, §6.3, §14.2). */
export const IDENTITY_DOMAIN = {
  RouteTag: "CEMP-ROUTE-V1",
  ConversationId: "CEMP-CONVERSATION-V1",
} as const;

/**
 * Deterministic one-to-one conversation identifier (spec §6.3):
 *
 *   conversation_id = blake2b("CEMP-CONVERSATION-V1" || sort(profile_id_A, profile_id_B))
 *
 * Sorting both 32-byte profile IDs makes the result independent of argument order.
 */
export function deriveConversationId(profileIdA: Uint8Array, profileIdB: Uint8Array): Uint8Array {
  const [first, second] =
    compareBytes(profileIdA, profileIdB) <= 0 ? [profileIdA, profileIdB] : [profileIdB, profileIdA];
  return ckbHash(concatBytes(textEncoder.encode(IDENTITY_DOMAIN.ConversationId), first, second));
}

/**
 * Pseudonymous routing tag placed in message-cell type args (spec §6.1):
 *
 *   route_tag = blake2b("CEMP-ROUTE-V1" || recipient_profile_id || routing_epoch)
 *
 * `routingEpoch` is encoded as uint64 little-endian. This encoding is provisional
 * until the Phase 1 byte-level specification is written. Route tags provide
 * pseudonymous routing, NOT metadata privacy (spec §15).
 */
export function deriveRouteTag(recipientProfileId: Uint8Array, routingEpoch: bigint): Uint8Array {
  const epoch = new Uint8Array(8);
  new DataView(epoch.buffer).setBigUint64(0, routingEpoch, true);
  return ckbHash(
    concatBytes(textEncoder.encode(IDENTITY_DOMAIN.RouteTag), recipientProfileId, epoch),
  );
}
