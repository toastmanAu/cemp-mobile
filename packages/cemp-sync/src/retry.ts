/**
 * Exponential backoff policy (spec Phase 9 task 3).
 *
 * `delay(attempt)` = min(capMs, baseMs * multiplier^attempt) with ±25%
 * jitter (the jitter avoids thundering-herd retries across devices).
 * Attempts are 0-based: the first retry waits ~baseMs. Randomness is
 * injectable for deterministic tests; production uses the OS CSPRNG via
 * @cemp/crypto's randomBytes.
 */

import { randomBytes } from "@cemp/crypto";

export interface BackoffOptions {
  readonly baseMs?: number;
  readonly multiplier?: number;
  readonly capMs?: number;
  /** 0..1 jitter fraction applied symmetrically (default 0.25). */
  readonly jitter?: number;
  /** Uniform random source in [0,1) (tests inject determinism). */
  readonly random?: () => number;
}

export class BackoffPolicy {
  readonly baseMs: number;
  readonly multiplier: number;
  readonly capMs: number;
  readonly jitter: number;
  readonly #random: () => number;

  constructor(options: BackoffOptions = {}) {
    this.baseMs = options.baseMs ?? 30_000;
    this.multiplier = options.multiplier ?? 2;
    this.capMs = options.capMs ?? 30 * 60_000;
    this.jitter = options.jitter ?? 0.25;
    this.#random =
      options.random ??
      (() => {
        const bytes = randomBytes(4);
        return (
          ((bytes[0]! * 256 ** 3 + bytes[1]! * 256 ** 2 + bytes[2]! * 256 + bytes[3]!) / 2 ** 32) %
          1
        );
      });
  }

  /** Delay before retry number `attempt` (0-based), jittered and capped. */
  delay(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new Error(`backoff: attempt ${String(attempt)} is not a non-negative integer`);
    }
    const nominal = Math.min(this.capMs, this.baseMs * this.multiplier ** attempt);
    const spread = nominal * this.jitter;
    return Math.round(nominal - spread + 2 * spread * this.#random());
  }
}
