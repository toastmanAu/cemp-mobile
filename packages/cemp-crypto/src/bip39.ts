/**
 * BIP39 recovery container (spec §4): 12 or 24 English words plus an optional
 * passphrase, checksum-validated.
 *
 * BIP39 is ONLY the recovery container. Protocol keys are domain-separated
 * HKDF-SHA-256 sub-seeds of the 64-byte BIP39 seed (see `identity.ts`,
 * spec §4/§5.1); non-hardened BIP32 derivation MUST NOT be used for
 * post-quantum keys.
 *
 * AGENTS.md rule 2: the mnemonic, passphrase and seed are secret. Nothing in
 * this module logs, and error paths forward only library messages that
 * describe word counts/checksums, never phrase contents.
 */

import {
  generateMnemonic as scureGenerateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic as scureValidateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** Byte length of the standard BIP39 seed (PBKDF2-HMAC-SHA512 output). */
export const BIP39_SEED_BYTES = 64;

/**
 * Generate a fresh English BIP39 mnemonic: 12 words (128-bit entropy) or
 * 24 words (256-bit entropy). Uses `crypto.getRandomValues` internally.
 */
export function generateMnemonic(wordCount: 12 | 24): string {
  return scureGenerateMnemonic(wordlist, wordCount === 12 ? 128 : 256);
}

/** Checksum-validated mnemonic check (word count, wordlist membership, checksum). */
export function validateMnemonic(words: string): boolean {
  return scureValidateMnemonic(words, wordlist);
}

/**
 * Standard BIP39 seed derivation: PBKDF2-HMAC-SHA512, 2048 rounds, salt
 * "mnemonic" + passphrase, NFKD-normalized — 64 output bytes.
 *
 * Uses the synchronous pure-JS PBKDF2 from @noble/hashes. The WebCrypto
 * variant is deliberately not used: `crypto.subtle` is unavailable under
 * Hermes.
 */
export function mnemonicToSeed(words: string, passphrase?: string): Uint8Array {
  return mnemonicToSeedSync(words, passphrase);
}
