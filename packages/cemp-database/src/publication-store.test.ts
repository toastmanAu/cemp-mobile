import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import { NodeSqliteAdapter } from "./node.js";
import { ContactRepository } from "./repositories/contacts.js";
import { ConversationRepository } from "./repositories/conversations.js";
import { MessageRepository } from "./repositories/messages.js";
import { OutgoingTransactionRepository } from "./repositories/outgoing-transactions.js";
import { DatabasePublicationStore } from "./repositories/publication-store.js";

/**
 * The PublicationStore adapter (Phase 7): journal semantics over the real
 * repositories — idempotent records, purpose lookup for crash-resume, and
 * state transitions flowing through the §11 machine.
 */
async function makeStack() {
  const db = new NodeSqliteAdapter();
  await migrate(db);
  const contacts = new ContactRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  const outgoingTxs = new OutgoingTransactionRepository(db);
  const store = new DatabasePublicationStore(messages, outgoingTxs);
  return { db, contacts, conversations, messages, outgoingTxs, store };
}

describe("OutgoingTransactionRepository", () => {
  it("record is idempotent on tx_hash; findLatestByPurpose returns the newest", async () => {
    const { db, outgoingTxs } = await makeStack();
    try {
      const first = await outgoingTxs.record({
        txHash: "0x01",
        purpose: "message:lm-1",
        state: "submitted",
        feeShannon: "1000",
      });
      const again = await outgoingTxs.record({
        txHash: "0x01",
        purpose: "message:lm-1",
        state: "submitted",
      });
      expect(again.id).toBe(first.id);

      // A retry produced a NEW tx for the same purpose → latest wins.
      await outgoingTxs.record({ txHash: "0x02", purpose: "message:lm-1", state: "submitted" });
      expect((await outgoingTxs.findLatestByPurpose("message:lm-1"))?.txHash).toBe("0x02");

      await outgoingTxs.markState("0x02", "committed", { committedAtMs: 1234, blockHash: "0xaa" });
      const committed = await outgoingTxs.getByTxHash("0x02");
      expect(committed?.state).toBe("committed");
      expect(committed?.committedAtMs).toBe(1234);
      expect(committed?.blockHash).toBe("0xaa");
      // Same-state re-mark is a no-op, not an error.
      await outgoingTxs.markState("0x02", "committed");
      expect((await outgoingTxs.listByState("committed")).map((t) => t.txHash)).toEqual(["0x02"]);
      await expect(outgoingTxs.markState("0x99", "committed")).rejects.toMatchObject({
        code: "not-found",
      });
    } finally {
      await db.close();
    }
  });
});

describe("DatabasePublicationStore", () => {
  it("drives message transitions, chain refs and the crash-resume purpose lookup", async () => {
    const { db, contacts, conversations, messages, store } = await makeStack();
    try {
      const contact = await contacts.create({ displayName: "bob" });
      const conv = await conversations.getOrCreateForContact(contact.id);
      const message = await messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "pipeline text",
        logicalMessageId: "lm-store",
      });

      // The publisher's exact call sequence (pre-broadcast).
      await store.transitionMessage(message.id, "queued");
      await store.transitionMessage(message.id, "encrypting");
      await store.transitionMessage(message.id, "building_transaction");
      await store.transitionMessage(message.id, "awaiting_signature");
      await store.transitionMessage(message.id, "submitting");
      await store.recordOutgoingTx({
        txHash: "0xfeed",
        purpose: "message:lm-store",
        state: "submitted",
        feeShannon: "461",
        submittedAtMs: 1000,
      });
      await store.setMessageChainRef(message.id, { txHash: "0xfeed", outpointIndex: 0 });
      await store.transitionMessage(message.id, "pending");

      // Crash-resume lookup finds the journaled tx by the logical id.
      const resume = await store.findOutgoingTxByPurpose("message:lm-store");
      expect(resume?.txHash).toBe("0xfeed");
      expect(resume?.state).toBe("submitted");
      // The chain ref persisted (rule 6: journal before broadcast).
      expect((await messages.getChainRef(message.id))?.txHash).toBe("0xfeed");

      await store.markOutgoingTxState("0xfeed", "committed", 2000);
      await store.transitionMessage(message.id, "committed");
      await store.transitionMessage(message.id, "available_on_chain");
      expect((await messages.getById(message.id))?.state).toBe("available_on_chain");
      expect((await store.findOutgoingTxByPurpose("message:lm-store"))?.state).toBe("committed");
    } finally {
      await db.close();
    }
  });

  it("illegal transitions still throw through the adapter (§11 machine)", async () => {
    const { db, contacts, conversations, messages, store } = await makeStack();
    try {
      const contact = await contacts.create({ displayName: "bob" });
      const conv = await conversations.getOrCreateForContact(contact.id);
      const message = await messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "x",
        logicalMessageId: "lm-illegal",
      });
      await expect(store.transitionMessage(message.id, "committed")).rejects.toMatchObject({
        code: "illegal-state-transition",
      });
    } finally {
      await db.close();
    }
  });
});
