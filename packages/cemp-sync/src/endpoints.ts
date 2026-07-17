/**
 * Endpoint failure rotation (spec Phase 9 task 7; §13 "first healthy endpoint
 * wins, failures rotate").
 *
 * Tracks consecutive failures per run; after `failureThreshold` consecutive
 * failures the active endpoint advances (round-robin) and the new index is
 * PERSISTED (sync cursor `endpoint-rotation`) so a restart keeps the healthy
 * choice. Any success resets the counter.
 */

import type { NetworkEndpoints } from "@cemp/core";
import type { SyncCursorRepository } from "@cemp/database";

const CURSOR_NAME = "endpoint-rotation";

export class EndpointRotator {
  readonly #endpoints: readonly NetworkEndpoints[];
  readonly #cursors: SyncCursorRepository;
  readonly #threshold: number;
  #index = 0;
  #consecutiveFailures = 0;
  #loaded = false;

  constructor(
    endpoints: readonly NetworkEndpoints[],
    cursors: SyncCursorRepository,
    failureThreshold = 3,
  ) {
    if (endpoints.length === 0) {
      throw new Error("EndpointRotator: at least one endpoint is required");
    }
    this.#endpoints = endpoints;
    this.#cursors = cursors;
    this.#threshold = failureThreshold;
  }

  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    const raw = await this.#cursors.get(CURSOR_NAME);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { index?: unknown };
        if (
          typeof parsed.index === "number" &&
          parsed.index >= 0 &&
          parsed.index < this.#endpoints.length
        ) {
          this.#index = parsed.index;
        }
      } catch {
        // Corrupt cursor → start from the first endpoint.
      }
    }
    this.#loaded = true;
  }

  async #persist(): Promise<void> {
    await this.#cursors.set(CURSOR_NAME, JSON.stringify({ index: this.#index }));
  }

  /** The currently active endpoint (loads the persisted choice on first call). */
  async current(): Promise<NetworkEndpoints> {
    await this.#load();
    return this.#endpoints[this.#index]!;
  }

  /** Record a success against the active endpoint (resets the failure streak). */
  async reportSuccess(): Promise<void> {
    await this.#load();
    this.#consecutiveFailures = 0;
  }

  /**
   * Record a failure against the active endpoint. Returns true when the
   * active endpoint ROTATED as a result.
   */
  async reportFailure(): Promise<boolean> {
    await this.#load();
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures < this.#threshold || this.#endpoints.length === 1) {
      return false;
    }
    this.#index = (this.#index + 1) % this.#endpoints.length;
    this.#consecutiveFailures = 0;
    await this.#persist();
    return true;
  }
}
