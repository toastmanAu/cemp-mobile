import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { OutgoingTransactionRepository, migrate } from "@cemp/database";
import type { SqliteAdapter } from "@cemp/database";
import { NodeSqliteAdapter } from "@cemp/database/node";
import { OutgoingTxJournalAdapter } from "./outgoing-tx-journal.js";

describe("OutgoingTxJournalAdapter", () => {
  let db: SqliteAdapter;
  let repo: OutgoingTransactionRepository;
  let journal: OutgoingTxJournalAdapter;

  beforeEach(async () => {
    db = new NodeSqliteAdapter();
    await migrate(db);
    repo = new OutgoingTransactionRepository(db);
    journal = new OutgoingTxJournalAdapter(repo);
  });
  afterEach(async () => { await db.close(); });

  it("records, marks state, and finds by purpose prefix", async () => {
    await journal.recordOutgoingTx({ txHash: "0xaa", purpose: "attachment-chunks:g1", state: "submitted" });
    await journal.markOutgoingTxState("0xaa", "committed", 1234);
    const found = await journal.findLatestOutgoingTxByPurposePrefix("attachment-chunks:");
    expect(found?.txHash).toBe("0xaa");
    expect(found?.state).toBe("committed");
  });

  it("returns undefined when no tx matches the prefix", async () => {
    expect(await journal.findLatestOutgoingTxByPurposePrefix("nope:")).toBeUndefined();
  });
});
