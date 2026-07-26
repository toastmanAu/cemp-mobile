import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { BalanceRepository, OutgoingTransactionRepository, migrate } from "@cemp/database";
import type { SqliteAdapter } from "@cemp/database";
import { NodeSqliteAdapter } from "@cemp/database/node";
import { AttachmentReclaimStoreAdapter, OutgoingTxJournalAdapter } from "./outgoing-tx-journal.js";

describe("OutgoingTxJournalAdapter", () => {
  let db: SqliteAdapter;
  let repo: OutgoingTransactionRepository;
  let balances: BalanceRepository;
  let walletId: number;
  let journal: OutgoingTxJournalAdapter;

  beforeEach(async () => {
    db = new NodeSqliteAdapter();
    await migrate(db);
    repo = new OutgoingTransactionRepository(db);
    balances = new BalanceRepository(db);
    walletId = await balances.ensureWallet("main");
    journal = new OutgoingTxJournalAdapter(repo, balances, walletId);
  });
  afterEach(async () => {
    await db.close();
  });

  it("records, marks state, and finds by purpose prefix", async () => {
    await journal.recordOutgoingTx({
      txHash: "0xaa",
      purpose: "attachment-chunks:g1",
      state: "submitted",
    });
    await journal.markOutgoingTxState("0xaa", "committed", 1234);
    const found = await journal.findLatestOutgoingTxByPurposePrefix("attachment-chunks:");
    expect(found?.txHash).toBe("0xaa");
    expect(found?.state).toBe("committed");
  });

  it("returns undefined when no tx matches the prefix", async () => {
    expect(await journal.findLatestOutgoingTxByPurposePrefix("nope:")).toBeUndefined();
  });

  it("reserves chunk-cell capacity against the wallet balance (review M-1)", async () => {
    await balances.setChainBalances(walletId, 1_000_000n, 1_000_000n);
    await journal.reserveCapacity("400000");
    const balance = await balances.getBalance(walletId);
    expect(balance.reservedShannon).toBe(400_000n);
    expect(balance.availableShannon).toBe(600_000n);
  });
});

describe("AttachmentReclaimStoreAdapter", () => {
  let db: SqliteAdapter;
  let repo: OutgoingTransactionRepository;
  let balances: BalanceRepository;
  let walletId: number;
  let store: AttachmentReclaimStoreAdapter;

  beforeEach(async () => {
    db = new NodeSqliteAdapter();
    await migrate(db);
    repo = new OutgoingTransactionRepository(db);
    balances = new BalanceRepository(db);
    walletId = await balances.ensureWallet("main");
    store = new AttachmentReclaimStoreAdapter(repo, balances, walletId);
  });
  afterEach(async () => {
    await db.close();
  });

  it("walks the capacity buckets: reserve → reclaimable → release + fee burn (M-1/E7)", async () => {
    await balances.setChainBalances(walletId, 1_000_000n, 1_000_000n);
    await store.reserveCapacity("500000");
    await store.markCapacityReclaimable("500000");
    await store.releaseReclaimedCapacity("499000");
    await store.recordFeeBurn("1000");
    const balance = await balances.getBalance(walletId);
    expect(balance.availableShannon).toBe(999_000n);
    expect(balance.reservedShannon).toBe(0n);
    expect(balance.reclaimableShannon).toBe(0n);
  });

  it("markOutgoingTxStateIf is a compare-and-swap (review I-6)", async () => {
    await store.recordOutgoingTx({
      txHash: "0xbb",
      purpose: "reclaim-attachment:g1",
      state: "submitted",
    });
    expect(await store.markOutgoingTxStateIf("0xbb", "submitted", "committed", 42)).toBe(1);
    // A second caller loses the race — no double-release.
    expect(await store.markOutgoingTxStateIf("0xbb", "submitted", "committed", 43)).toBe(0);
  });
});
