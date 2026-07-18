/**
 * Balance repository (spec §5.5 balance categories; Phase 8 task 8).
 *
 * Tracks the wallet_balances row: total, available, reserved-for-pending-
 * messages, reclaimable, pending. Amounts are u64 shannon stored as decimal
 * TEXT (they exceed Number.MAX_SAFE_INTEGER); arithmetic is BigInt. This
 * repository does no chain access — it records what the pipelines tell it,
 * and the Phase 4 wallet-foundation card owns the indexer-driven refresh.
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";

export interface WalletBalance {
  readonly walletId: number;
  readonly totalShannon: bigint;
  readonly availableShannon: bigint;
  readonly reservedShannon: bigint;
  readonly reclaimableShannon: bigint;
  readonly pendingShannon: bigint;
  readonly updatedAtMs: number;
}

function rowToBalance(row: SqlRow): WalletBalance {
  return {
    walletId: Number(row.wallet_id),
    totalShannon: BigInt(String(row.total_shannon)),
    availableShannon: BigInt(String(row.available_shannon)),
    reservedShannon: BigInt(String(row.reserved_shannon)),
    reclaimableShannon: BigInt(String(row.reclaimable_shannon)),
    pendingShannon: BigInt(String(row.pending_shannon)),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class BalanceRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  /** Create a wallet with a zeroed balance row; returns the wallet id. */
  async ensureWallet(name: string): Promise<number> {
    const existing = await this.#db.get("SELECT id FROM wallets WHERE name = ?", [name]);
    if (existing !== undefined) {
      return Number(existing.id);
    }
    const result = await this.#db.run("INSERT INTO wallets (name, created_at_ms) VALUES (?, ?)", [
      name,
      Date.now(),
    ]);
    const walletId = result.lastInsertRowid;
    await this.#db.run(
      `INSERT INTO wallet_balances
         (wallet_id, total_shannon, available_shannon, reserved_shannon, reclaimable_shannon, pending_shannon, updated_at_ms)
       VALUES (?, '0', '0', '0', '0', '0', ?)`,
      [walletId, Date.now()],
    );
    return walletId;
  }

  async getBalance(walletId: number): Promise<WalletBalance> {
    const row = await this.#db.get("SELECT * FROM wallet_balances WHERE wallet_id = ?", [walletId]);
    if (row === undefined) {
      throw new DatabaseError("not-found", `wallet ${String(walletId)} has no balance row`);
    }
    return rowToBalance(row);
  }

  /**
   * Set the chain-derived categories (Phase 4 refresh path): total and
   * available come from the indexer; the protocol categories are ours.
   */
  async setChainBalances(
    walletId: number,
    totalShannon: bigint,
    availableShannon: bigint,
  ): Promise<void> {
    await this.#db.run(
      "UPDATE wallet_balances SET total_shannon = ?, available_shannon = ?, updated_at_ms = ? WHERE wallet_id = ?",
      [totalShannon.toString(), availableShannon.toString(), Date.now(), walletId],
    );
  }

  /** Move capacity available → reserved (a message cell was published). */
  async reserveCapacity(walletId: number, amountShannon: bigint): Promise<void> {
    await this.#move(walletId, "available_shannon", "reserved_shannon", amountShannon);
  }

  /** Move capacity reserved → reclaimable (the message can now be reclaimed). */
  async markReclaimable(walletId: number, amountShannon: bigint): Promise<void> {
    await this.#move(walletId, "reserved_shannon", "reclaimable_shannon", amountShannon);
  }

  /** Return capacity reclaimable → available (a reclaim committed, Phase 8 task 8). */
  async releaseReclaimedCapacity(walletId: number, amountShannon: bigint): Promise<void> {
    await this.#move(walletId, "reclaimable_shannon", "available_shannon", amountShannon);
  }

  /**
   * Write off reclaimable capacity burned as a reclaim transaction's fee
   * (review E7): the fee left the wallet, so the bucket is debited with no
   * credit anywhere. Floored at zero — partial funding can never go negative.
   */
  async recordFeeBurn(walletId: number, amountShannon: bigint): Promise<void> {
    if (amountShannon <= 0n) {
      return;
    }
    await this.#db.run(
      "UPDATE wallet_balances SET reclaimable_shannon = MAX(0, CAST(reclaimable_shannon AS INTEGER) - CAST(? AS INTEGER)), updated_at_ms = ? WHERE wallet_id = ?",
      [amountShannon.toString(), Date.now(), walletId],
    );
  }

  /** Atomic move between two categories; refuses to drive either negative. */
  async #move(walletId: number, from: string, to: string, amount: bigint): Promise<void> {
    if (amount <= 0n) {
      throw new DatabaseError("constraint-violation", "capacity move amount must be positive");
    }
    await this.#db.transaction(async () => {
      const balance = await this.getBalance(walletId);
      const columns: Record<string, bigint> = {
        available_shannon: balance.availableShannon,
        reserved_shannon: balance.reservedShannon,
        reclaimable_shannon: balance.reclaimableShannon,
        pending_shannon: balance.pendingShannon,
      };
      const fromValue = columns[from];
      const toValue = columns[to];
      if (fromValue === undefined || toValue === undefined) {
        throw new DatabaseError("constraint-violation", `unknown balance category ${from}/${to}`);
      }
      if (fromValue < amount) {
        throw new DatabaseError(
          "constraint-violation",
          `insufficient ${from}: have ${fromValue.toString()}, need ${amount.toString()}`,
        );
      }
      await this.#db.run(
        `UPDATE wallet_balances SET ${from} = ?, ${to} = ?, updated_at_ms = ? WHERE wallet_id = ?`,
        [(fromValue - amount).toString(), (toValue + amount).toString(), Date.now(), walletId],
      );
    });
  }
}
