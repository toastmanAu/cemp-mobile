/**
 * Has this out point been spent? (ADR 0009)
 *
 * CKB's `get_live_cell` does not track spent cells: for a cell that existed
 * and was consumed, a real node answers `unknown`, not `dead`. Observed on
 * testnet 2026-11-26 against a message cell spent 4 minutes earlier. Code that
 * waited for `dead` therefore never fired on a real node (the responder watch,
 * ack reclaim, the reclaim batch's already-spent branch), while every test
 * passed because the mock node answered `dead`.
 *
 * `spent` is concluded only from positive evidence: the cell is not live AND
 * its creating transaction is committed at least SPENT_CONFIRMATION_DEPTH
 * blocks below the tip AND the index is within that transaction's outputs. So
 * the cell provably existed, is old enough that every node behind a load
 * balancer has it, and is no longer live. Anything short of that stays
 * `unknown` (review E4: never flip irreversible state on missing information).
 */

import type {
  Cell,
  Header,
  LiveCellStatus,
  OutPoint,
  Transaction,
  TransactionStatus,
} from "./types.js";

/** Blocks the creating tx must be buried under before "not live" means spent (~3 min). */
export const SPENT_CONFIRMATION_DEPTH = 24;

/** The node reads this needs; `CempClient` satisfies it. */
export interface FateClient {
  getLiveCell(outPoint: OutPoint): Promise<LiveCellStatus>;
  getTransaction(hash: string): Promise<TransactionStatus>;
  getTransactionBody(hash: string): Promise<Transaction | null>;
  getTipHeader(): Promise<Header>;
}

export type OutPointFate =
  | { readonly fate: "live"; readonly cell: Cell }
  | { readonly fate: "spent" }
  | { readonly fate: "unknown" };

/**
 * Never throws: a node error at any step is `unknown` for THIS out point, so
 * one bad row cannot abort a whole reclaim batch or watch poll (review of
 * ADR 0009, M1). Callers retry `unknown` on their next pass.
 */
export async function resolveOutPointFate(
  client: FateClient,
  outPoint: OutPoint,
): Promise<OutPointFate> {
  try {
    return await resolve(client, outPoint);
  } catch {
    return { fate: "unknown" };
  }
}

async function resolve(client: FateClient, outPoint: OutPoint): Promise<OutPointFate> {
  const live = await client.getLiveCell(outPoint);
  if (live.status === "live") {
    return { fate: "live", cell: live.cell };
  }
  if (live.status === "dead") {
    return { fate: "spent" };
  }
  const created = await client.getTransaction(outPoint.txHash);
  if (created.status !== "committed") {
    return { fate: "unknown" };
  }
  const tip = BigInt((await client.getTipHeader()).number);
  if (tip - BigInt(created.blockNumber) < BigInt(SPENT_CONFIRMATION_DEPTH)) {
    return { fate: "unknown" };
  }
  const body = await client.getTransactionBody(outPoint.txHash);
  if (body === null || BigInt(outPoint.index) >= BigInt(body.outputs.length)) {
    return { fate: "unknown" };
  }
  // Re-check last (review LOW-1): behind a load-balanced endpoint the first
  // `unknown` may have come from a lagging backend. Two independent reads
  // must both say not-live, with the evidence gathered in between.
  const again = await client.getLiveCell(outPoint);
  if (again.status === "live") {
    return { fate: "live", cell: again.cell };
  }
  return { fate: "spent" };
}
