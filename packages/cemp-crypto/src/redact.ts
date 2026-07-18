/**
 * Log redaction (spec Phase 11 task 13, AGENTS.md rule 2).
 *
 * The logging boundary is expected to pass every message through
 * {@link redactSecrets} first. Two secret shapes are masked:
 *
 * 1. **Long hex** (≥ 128 contiguous hex chars): seeds, sub-seeds, secret
 *    keys, ciphertext blobs. 64-char hex (tx hashes, profile ids) is PUBLIC
 *    by design and kept — logs must stay useful for debugging.
 * 2. **BIP39 runs** (≥ 6 consecutive English-wordlist words): a full or
 *    partial mnemonic. A run this long never has a legitimate reason to be
 *    in a log.
 *
 * This is defense in depth: the codebase never logs secrets by design, and
 * redaction catches the accidents — third-party errors, stringified objects,
 * unexpected interpolation.
 */

import { wordlist } from "@scure/bip39/wordlists/english.js";

const WORD_SET = new Set<string>(wordlist);
const LONG_HEX = /\b(?:0x)?[0-9a-fA-F]{128,}\b/g;

/** Redact secret-shaped content from a log message. */
export function redactSecrets(text: string): string {
  const withoutHex = text.replace(LONG_HEX, "‹redacted:hex›");
  const tokens = withoutHex.split(/(\s+)/);
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    const wordCount = run.filter((t) => !/^\s+$/.test(t)).length;
    if (wordCount >= 6) {
      out.push("‹redacted:mnemonic›");
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const token of tokens) {
    const bare = token.toLowerCase().replace(/[^a-z]/g, "");
    if (WORD_SET.has(bare)) {
      run.push(token);
    } else if (/^\s+$/.test(token)) {
      // Whitespace stays inside a potential run (masked with it if it completes).
      run.push(token);
    } else {
      flush();
      out.push(token);
    }
  }
  flush();
  return out.join("");
}
