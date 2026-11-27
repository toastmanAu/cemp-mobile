import { deriveRotatedIdentityKeys, mnemonicToSeed, validateMnemonic } from "@cemp/crypto";
import type { IdentityKeyBundle } from "@cemp/crypto";
import type { RotationRecord } from "./state.js";

/**
 * ⚠️⚠️ TESTNET THROWAWAY IDENTITIES — NEVER SEND REAL FUNDS ⚠️⚠️
 *
 * These two BIP39 mnemonics are published in this repository ON PURPOSE: they
 * are the fixed, documented test identities of the headless reference client
 * (ckd.txt §20), so every run derives the same Alice and Bob and a resumed
 * run recognizes its own cells. They must only ever touch CKB **testnet**
 * (valueless). NEVER send mainnet CKB or anything of value to these
 * addresses, and never reuse these phrases for a real wallet — the secret
 * keys are public.
 */
export const ALICE_MNEMONIC =
  "armed alert aware arm shield unaware citizen soup egg argue tilt category";
/** See the warning on {@link ALICE_MNEMONIC}. Testnet throwaway only. */
export const BOB_MNEMONIC =
  "fan motion column install stool oak machine truly adapt charge head soup";

export type IdentityName = "alice" | "bob";

export const IDENTITY_NAMES: readonly IdentityName[] = ["alice", "bob"];

/** Profile handles published in the profile cells (protocol spec §5). */
export const IDENTITY_HANDLES: Record<IdentityName, string> = {
  alice: "alice-ref",
  bob: "bob-ref",
};

function mnemonicFor(name: IdentityName): string {
  return name === "alice" ? ALICE_MNEMONIC : BOB_MNEMONIC;
}

/**
 * Derive the full identity key bundle for a test identity (spec §4: BIP39
 * seed → domain-separated HKDF sub-seeds → deterministic ML-DSA-65 /
 * ML-KEM-768 keygen). Deterministic across runs by construction.
 */
export function deriveIdentity(name: IdentityName): IdentityKeyBundle {
  return deriveProfileKeys(name, 0);
}

/**
 * The key bundle of an identity's profile at `rotation` (protocol §5.1:
 * rotation n is deterministic from the same seed). Rotation 0 is the base
 * identity, which is also the funding wallet in this harness.
 */
export function deriveProfileKeys(name: IdentityName, rotation: number): IdentityKeyBundle {
  const mnemonic = mnemonicFor(name);
  if (!validateMnemonic(mnemonic)) {
    // Static phrases shipped in this file — a failure here is a code edit bug.
    throw new Error(`identities.ts: the hard-coded ${name} mnemonic failed checksum validation`);
  }
  const seed = mnemonicToSeed(mnemonic);
  try {
    return deriveRotatedIdentityKeys(seed, rotation);
  } finally {
    seed.fill(0);
  }
}

/**
 * Which rotation an identity's LIVE profile is at. Only alice rotates in this
 * harness (the rotate step, recorded in `shared.rotation`), once.
 */
export function currentRotationIndex(name: IdentityName, rotation: RotationRecord | null): number {
  return name === "alice" && rotation !== null ? 1 : 0;
}
