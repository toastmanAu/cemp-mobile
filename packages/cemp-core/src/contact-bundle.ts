/**
 * CEMP contact bundle v1 (spec §5.4, Phase 5 task 9).
 *
 * The QR payload for contact exchange — a small versioned JSON document:
 *
 * ```json
 * {
 *   "protocol": "cemp-contact",
 *   "version": 1,
 *   "network": "ckb_testnet",
 *   "profileTypeId": "0x…64hex",
 *   "lockScriptHash": "0x…64hex",
 *   "address": "ckt1…",
 *   "fingerprint": "XXXX-XXXX-…-XXXX"
 * }
 * ```
 *
 * It contains NO secret material (spec §5.4). A scanned bundle is hostile
 * input (rule 4): decoding is strict — unknown protocol/version rejected,
 * the network must be the configured one (testnet-only builds reject
 * mainnet, rule 11), all hex/bech32 shapes validated, and the fingerprint
 * must parse canonically. Full trust still requires resolving the on-chain
 * profile and re-computing the fingerprint (see profile-trust.ts).
 */

import { parseFingerprint } from "./fingerprint.js";
import { CKB_TESTNET } from "./network.js";

export const CONTACT_BUNDLE_PROTOCOL = "cemp-contact";
export const CONTACT_BUNDLE_VERSION = 1;

export interface ContactBundleV1 {
  /** 0x-prefixed 32-byte Type ID of the contact's profile cell. */
  readonly profileTypeId: string;
  /** 0x-prefixed 32-byte lock script hash of the contact's messaging lock. */
  readonly lockScriptHash: string;
  /** bech32(m) CKB address (ckt1… on testnet). */
  readonly address: string;
  /** Display-form profile fingerprint. */
  readonly fingerprint: string;
  /** Network id — only "ckb_testnet" exists in v1. */
  readonly network: string;
}

/** Canonical wire JSON (fixed key order, matching the spec §5.4 example). */
export function encodeContactBundle(bundle: ContactBundleV1): string {
  return JSON.stringify({
    protocol: CONTACT_BUNDLE_PROTOCOL,
    version: CONTACT_BUNDLE_VERSION,
    network: bundle.network,
    profileTypeId: bundle.profileTypeId,
    lockScriptHash: bundle.lockScriptHash,
    address: bundle.address,
    fingerprint: bundle.fingerprint,
  });
}

function fail(detail: string): never {
  throw new Error(`contact bundle: ${detail}`);
}

function expectHash32(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    fail(`${field} must be 0x-prefixed lowercase 32-byte hex`);
  }
  return value;
}

/**
 * Strictly decode a scanned bundle. `expectedNetwork` defaults to this
 * build's only network (CKB testnet — rule 11); a bundle naming any other
 * network is rejected.
 */
export function decodeContactBundle(
  text: string,
  expectedNetwork: string = CKB_TESTNET.name,
): ContactBundleV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.protocol !== CONTACT_BUNDLE_PROTOCOL) {
    fail("unknown protocol marker");
  }
  if (obj.version !== CONTACT_BUNDLE_VERSION) {
    fail(`unsupported version ${JSON.stringify(obj.version)}`);
  }
  if (obj.network !== expectedNetwork) {
    fail(`network ${JSON.stringify(obj.network)} is not ${expectedNetwork}`);
  }
  const profileTypeId = expectHash32(obj.profileTypeId, "profileTypeId");
  const lockScriptHash = expectHash32(obj.lockScriptHash, "lockScriptHash");
  if (typeof obj.address !== "string" || obj.address.length === 0 || obj.address.length > 128) {
    fail("address must be a non-empty string");
  }
  const address = obj.address;
  if (expectedNetwork === CKB_TESTNET.name && !address.startsWith("ckt1")) {
    fail("address is not a testnet (ckt1) address");
  }
  if (typeof obj.fingerprint !== "string") {
    fail("fingerprint must be a string");
  }
  let fingerprint: string;
  try {
    fingerprint = parseFingerprint(obj.fingerprint);
  } catch {
    fail("fingerprint is malformed");
  }
  return {
    profileTypeId,
    lockScriptHash,
    address,
    fingerprint: fingerprint!,
    network: obj.network,
  };
}
