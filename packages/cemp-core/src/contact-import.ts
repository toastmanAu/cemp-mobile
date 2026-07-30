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

import {
  CONTACT_BUNDLE_PROTOCOL,
  CONTACT_BUNDLE_VERSION,
  decodeContactBundle,
  type ContactBundleV1,
} from "./contact-bundle.js";
import { CKB_TESTNET } from "./network.js";

/**
 * A closed set of app-authored reasons a scanned card was rejected.
 *
 * NOT free text: `decodeContactBundle`'s thrown messages interpolate
 * card-controlled fields (e.g. the scanned "network" string), so forwarding
 * them to the UI would hand a crafted card control over the error banner
 * (a spoofing surface, even though the bundle carries no secret material).
 * Each code is mapped to its own app-authored sentence by the screen.
 */
export type UnreadableReason =
  | "not-a-card" // not JSON, not an object, or wrong protocol marker
  | "unsupported-version" // a newer CellSend wrote it
  | "wrong-network" // rule 11 — a different chain
  | "damaged"; // structurally invalid: bad hex, address, or fingerprint

export type ScanOutcome =
  | { readonly kind: "addable"; readonly bundle: ContactBundleV1 }
  | { readonly kind: "self"; readonly bundle: ContactBundleV1 }
  | {
      readonly kind: "duplicate";
      readonly bundle: ContactBundleV1;
      readonly existingContactId: number;
    }
  | { readonly kind: "unreadable"; readonly reason: UnreadableReason };

/**
 * Classify the structural shape of scanned JSON WITHOUT trusting any of its
 * text — used only to pick an app-authored {@link UnreadableReason}.
 *
 * This deliberately duplicates three of `decodeContactBundle`'s checks
 * (protocol, version, network). That is not drift risk: `decodeContactBundle`
 * remains the sole authority on validity — this function never accepts a
 * bundle it rejects, it only downgrades the generic "damaged" outcome to a
 * more specific code when it can prove the mismatch itself, from the parsed
 * JSON, without touching the decoder's error text.
 */
function classifyUnreadable(trimmed: string): UnreadableReason {
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return "not-a-card";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "not-a-card";
  }
  const obj = raw as Record<string, unknown>;
  if (obj.protocol !== CONTACT_BUNDLE_PROTOCOL) {
    return "not-a-card";
  }
  if (obj.version !== CONTACT_BUNDLE_VERSION) {
    return "unsupported-version";
  }
  if (obj.network !== CKB_TESTNET.name) {
    return "wrong-network";
  }
  return "damaged";
}

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

/**
 * The never-throws guarantee below covers decoding only. `findExisting` is
 * caller-supplied and is expected not to throw.
 */
export function classifyScannedCard(input: {
  readonly text: string;
  /** This device's own profile id as the database stores it, or null if unpublished. */
  readonly myProfileIdHex: string | null;
  /** Repository lookup, called with the UNPREFIXED id. Expected not to throw. */
  readonly findExisting: (profileIdHex: string) => { readonly id: number } | undefined;
}): ScanOutcome {
  const trimmed = input.text.trim();
  let bundle: ContactBundleV1;
  try {
    bundle = decodeContactBundle(trimmed);
  } catch {
    // decodeContactBundle's message may embed card-controlled text (e.g. the
    // scanned network string) — never forward it. Classify structurally
    // instead so the reason shown to the user is always app-authored.
    return { kind: "unreadable", reason: classifyUnreadable(trimmed) };
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
