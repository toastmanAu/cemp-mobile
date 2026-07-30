/**
 * Classifying a scanned contact card.
 *
 * Pure and RN-free so the whole decision — parse, self, duplicate — is
 * unit-tested on Linux rather than on a phone. The UI's only job is to render
 * the outcome.
 *
 * A scanned card is hostile input (AGENTS.md rule 4): decoding goes through
 * the spec'd `decodeContactBundle`, which rejects unknown protocol/version,
 * wrong network (rule 11), and malformed hex/bech32/fingerprint shapes.
 */

import { decodeContactBundle, type ContactBundleV1 } from "./contact-bundle.js";

export type ScanOutcome =
  | { readonly kind: "addable"; readonly bundle: ContactBundleV1 }
  | { readonly kind: "self"; readonly bundle: ContactBundleV1 }
  | {
      readonly kind: "duplicate";
      readonly bundle: ContactBundleV1;
      readonly existingContactId: number;
    }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Bring a profile id to the database's form: no `0x`, lowercase.
 *
 * The ONE place the prefix asymmetry is resolved. `ContactBundleV1
 * .profileTypeId` is `0x`-prefixed; the contacts table's `profileIdHex` is
 * not. Comparing them unnormalised does not throw — it silently makes every
 * duplicate look new and every self-card look like a stranger.
 */
export function normalizeProfileId(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith("0x") ? lower.slice(2) : lower;
}

export function classifyScannedCard(input: {
  readonly text: string;
  /** This device's own profile id as the database stores it, or null if unpublished. */
  readonly myProfileIdHex: string | null;
  /** Repository lookup, called with the UNPREFIXED id. */
  readonly findExisting: (profileIdHex: string) => { readonly id: number } | undefined;
}): ScanOutcome {
  let bundle: ContactBundleV1;
  try {
    bundle = decodeContactBundle(input.text.trim());
  } catch (e) {
    // The reason is shown to the user, so it must not carry payload content;
    // decodeContactBundle's messages describe the shape fault only.
    return { kind: "unreadable", reason: e instanceof Error ? e.message : "unreadable card" };
  }

  const scanned = normalizeProfileId(bundle.profileTypeId);

  // Self wins over duplicate: if it is your own card, saying so is more useful
  // than pointing at whatever row happens to hold your id.
  if (input.myProfileIdHex !== null && normalizeProfileId(input.myProfileIdHex) === scanned) {
    return { kind: "self", bundle };
  }

  const existing = input.findExisting(scanned);
  if (existing !== undefined) {
    return { kind: "duplicate", bundle, existingContactId: existing.id };
  }
  return { kind: "addable", bundle };
}
