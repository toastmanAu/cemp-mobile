/**
 * Per-contact and global rate limits (spec Phase 11 task 9).
 *
 * Token buckets, continuously refilled, persisted through a store (the
 * cemp-database rate_limits table — limits survive process death and
 * reboot; an attacker cannot reset them by waiting out the app). Every
 * consume charges the per-contact bucket AND the global bucket: a single
 * spammy contact cannot exhaust the fleet allowance, and many contacts
 * cannot collectively amplify past it.
 *
 * Defaults are deliberately conservative for a cell-funded messenger:
 * 60 messages/hour per contact, 600/hour global (burst = the hourly rate).
 */

export interface RateLimitBucketState {
  readonly tokens: number;
  readonly updatedAtMs: number;
}

export interface RateLimitStore {
  get(bucket: string): Promise<RateLimitBucketState | undefined>;
  set(bucket: string, tokens: number, updatedAtMs: number): Promise<void>;
}

export interface RateLimiterConfig {
  readonly perContactPerHour: number;
  readonly globalPerHour: number;
  /** Clock injection for tests (defaults to Date.now). */
  readonly now?: () => number;
}

export const DEFAULT_RATE_LIMITS = {
  perContactPerHour: 60,
  globalPerHour: 600,
} as const;

const HOUR_MS = 3_600_000;

export class RateLimiter {
  readonly #store: RateLimitStore;
  readonly #config: RateLimiterConfig;
  readonly #now: () => number;

  constructor(store: RateLimitStore, config: RateLimiterConfig) {
    this.#store = store;
    this.#config = config;
    this.#now = config.now ?? Date.now;
  }

  /**
   * Try to consume one message of allowance for `scope` from
   * `profileIdHex` (null = unknown sender, charged to global only).
   * Returns true when the message may proceed; false = rate-limited.
   */
  async consume(scope: "outgoing" | "incoming", profileIdHex: string | null): Promise<boolean> {
    const now = this.#now();
    const global = await this.#refill(`${scope}:global`, this.#config.globalPerHour, now);
    if (profileIdHex === null) {
      if (global < 1) {
        return false;
      }
      await this.#store.set(`${scope}:global`, global - 1, now);
      return true;
    }
    const contact = await this.#refill(
      `${scope}:${profileIdHex}`,
      this.#config.perContactPerHour,
      now,
    );
    if (contact < 1 || global < 1) {
      return false;
    }
    await this.#store.set(`${scope}:${profileIdHex}`, contact - 1, now);
    await this.#store.set(`${scope}:global`, global - 1, now);
    return true;
  }

  /** Current token level after refill (UI "you are being rate-limited" hints). */
  async available(scope: "outgoing" | "incoming", profileIdHex: string): Promise<number> {
    return Math.floor(
      await this.#refill(`${scope}:${profileIdHex}`, this.#config.perContactPerHour, this.#now()),
    );
  }

  async #refill(bucket: string, perHour: number, now: number): Promise<number> {
    const existing = await this.#store.get(bucket);
    if (existing === undefined) {
      await this.#store.set(bucket, perHour, now);
      return perHour;
    }
    const elapsed = Math.max(0, now - existing.updatedAtMs);
    const tokens = Math.min(perHour, existing.tokens + (elapsed / HOUR_MS) * perHour);
    return tokens;
  }
}
