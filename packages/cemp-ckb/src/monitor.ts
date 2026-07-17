/**
 * Transaction status monitoring (spec Phase 7 task 8).
 *
 * Polls `getTransaction` until the transaction commits, is rejected, or the
 * deadline passes. The publisher drives this after broadcast; the Phase 9
 * pending-transaction worker will drive the same helper on restart.
 */

import { CempCkbError, type CempClient } from "./client.js";
import type { Hash } from "./types.js";

export interface WaitForCommitOptions {
  /** Overall deadline (default 180 s). */
  readonly timeoutMs?: number;
  /** Poll interval (default 4 s). */
  readonly pollMs?: number;
  /** Status callback (UI progress lines; receives no secret material). */
  readonly onStatus?: (status: string) => void;
}

export interface CommitResult {
  readonly txHash: Hash;
  readonly blockHash: string;
  readonly blockNumber: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for `txHash` to reach `committed`. Throws {@link CempCkbError} with
 * context "monitor" on rejection or timeout — the caller maps those to
 * user-readable failures (publisher.ts).
 */
export async function waitForTransactionCommit(
  client: CempClient,
  txHash: Hash,
  options: WaitForCommitOptions = {},
): Promise<CommitResult> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await client.getTransaction(txHash);
    if (status.status === "committed") {
      return { txHash, blockHash: status.blockHash, blockNumber: status.blockNumber };
    }
    if (status.status === "rejected") {
      throw new CempCkbError(
        "monitor",
        `transaction was rejected${status.reason === undefined ? "" : `: ${status.reason}`}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CempCkbError(
        "monitor",
        `timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for commit (last status: ${status.status})`,
      );
    }
    options.onStatus?.(status.status);
    await sleep(Math.min(pollMs, remaining));
  }
}
