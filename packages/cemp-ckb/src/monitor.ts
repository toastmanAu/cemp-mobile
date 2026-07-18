/**
 * Transaction status monitoring (spec Phase 7 task 8).
 *
 * Polls `getTransaction` until the transaction commits, is rejected, or the
 * deadline passes. The publisher drives this after broadcast; the Phase 9
 * pending-transaction worker will drive the same helper on restart.
 */

import { CempCkbError, type CempClient } from "./client.js";
import type { Hash, Transaction } from "./types.js";

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

/* ── journaled-broadcast resume (review E1) ──────────────────────────────── */

/**
 * The journal says the tx was submitted but the network never saw it and the
 * journal carries no usable rebroadcast material — the caller's abandon path
 * (requeue, or a user-facing failure) decides what happens next. NEVER thrown
 * for a tx that merely hasn't committed yet.
 */
export class JournaledAbandonedError extends Error {
  constructor(
    message: string,
    /** True when the inputs were consumed by a DIFFERENT transaction (double-spend). */
    readonly inputsSpentElsewhere: boolean,
  ) {
    super(message);
    this.name = "JournaledAbandonedError";
  }
}

export interface JournaledTx {
  readonly txHash: Hash;
  /** The signed wire transaction as JSON (schema v6; null for legacy rows). */
  readonly txHex: string | null;
}

export type ResumeBroadcastOutcome = "committed" | "rebroadcast";

/**
 * Resume a journaled broadcast (review E1). Order of truth:
 *
 * 1. `committed` on-chain already (broadcast happened before the crash) —
 *    nothing to do.
 * 2. In the mempool (`pending`/`proposed`) — wait for commit.
 * 3. `unknown` to the network and the journal holds signed bytes (schema v6)
 *    — REBROADCAST the journaled transaction and wait.
 * 4. `unknown` and no signed bytes (legacy journal), or the rebroadcast is
 *    rejected (its inputs were spent by a different tx while we were down) —
 *    {@link JournaledAbandonedError}: the pipeline unwedges instead of
 *    waiting forever (the old behaviour).
 */
export async function resumeJournaledBroadcast(
  client: CempClient,
  record: JournaledTx,
  options: WaitForCommitOptions = {},
): Promise<ResumeBroadcastOutcome> {
  const status = await client.getTransaction(record.txHash);
  if (status.status === "committed") {
    return "committed";
  }
  if (status.status === "rejected") {
    throw new JournaledAbandonedError(
      `journaled tx was rejected by the network${status.reason === undefined ? "" : `: ${status.reason}`}`,
      false,
    );
  }
  if (status.status === "pending" || status.status === "proposed") {
    await waitForTransactionCommit(client, record.txHash, options);
    return "committed";
  }
  // `unknown`: never seen by this node.
  if (record.txHex === null) {
    throw new JournaledAbandonedError(
      "journaled tx is unknown to the network and the journal holds no signed bytes",
      false,
    );
  }
  const wire = JSON.parse(record.txHex) as Transaction;
  let rebroadcastHash: Hash;
  try {
    rebroadcastHash = await client.sendTransaction(wire);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const spentElsewhere = /double.?spend|already|spent|dead|resolve/i.test(message);
    throw new JournaledAbandonedError(
      `rebroadcast of the journaled tx failed: ${message}`,
      spentElsewhere,
    );
  }
  if (rebroadcastHash !== record.txHash) {
    throw new CempCkbError(
      "monitor",
      "rebroadcast returned a tx hash different from the journaled transaction",
    );
  }
  await waitForTransactionCommit(client, record.txHash, options);
  return "rebroadcast";
}
