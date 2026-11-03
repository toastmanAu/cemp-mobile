import { describe, expect, it } from "vitest";
import { currentSchemaVersion, migrate } from "./migrate.js";
import { NodeSqliteAdapter } from "./node.js";
import { ContactRepository } from "./repositories/contacts.js";
import { ConversationRepository } from "./repositories/conversations.js";
import { MessageRepository } from "./repositories/messages.js";
import { OutgoingTransactionRepository } from "./repositories/outgoing-transactions.js";
import { DatabasePublicationStore } from "./repositories/publication-store.js";

/**
 * ADR 0006 / schema v10: `messages.receipt_key`. The sender's copy verifies
 * receipt proofs (exposed only through the lifecycle lookup); the
 * recipient's copy produces them later, even after the message cell is gone.
 */
async function makeStack() {
  const db = new NodeSqliteAdapter();
  await migrate(db);
  const contacts = new ContactRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  const store = new DatabasePublicationStore(messages, new OutgoingTransactionRepository(db));
  const contact = await contacts.create({ displayName: "bob", profileIdHex: "bb".repeat(32) });
  const conversation = await conversations.getOrCreateForContact(contact.id);
  return { db, messages, store, conversation };
}

const KEY = new Uint8Array(32).map((_, i) => i + 1);

describe("messages.receipt_key (schema v10)", () => {
  it("migrates to v10 with a nullable receipt_key column", async () => {
    const db = new NodeSqliteAdapter();
    try {
      await migrate(db);
      // v10 introduced the column; later versions keep it (v11: ADR 0007).
      expect(await currentSchemaVersion(db)).toBeGreaterThanOrEqual(10);
      const cols = await db.all("PRAGMA table_info(messages)");
      expect(cols.map((c) => String(c.name))).toContain("receipt_key");
    } finally {
      await db.close();
    }
  });

  it("set/get round-trips; absent is null; the getter returns a copy", async () => {
    const { db, messages, conversation } = await makeStack();
    try {
      const row = await messages.insert({
        conversationId: conversation.id,
        direction: "incoming",
        logicalMessageId: "incoming:01",
      });
      expect(await messages.getReceiptKey(row.id)).toBeNull();
      await messages.setReceiptKey(row.id, KEY);
      const first = await messages.getReceiptKey(row.id);
      expect(Array.from(first!)).toEqual(Array.from(KEY));
      first!.fill(0); // wiping a returned copy must not touch the stored key
      expect(Array.from((await messages.getReceiptKey(row.id))!)).toEqual(Array.from(KEY));
      // The key never rides along on ordinary message reads.
      expect(Object.keys((await messages.getById(row.id))!)).not.toContain("receiptKey");
    } finally {
      await db.close();
    }
  });

  it("rejects a wrong-length key and a missing row", async () => {
    const { db, messages, conversation } = await makeStack();
    try {
      const row = await messages.insert({
        conversationId: conversation.id,
        direction: "incoming",
        logicalMessageId: "incoming:02",
      });
      await expect(messages.setReceiptKey(row.id, new Uint8Array(31))).rejects.toThrow();
      await expect(messages.setReceiptKey(9999, KEY)).rejects.toMatchObject({ code: "not-found" });
    } finally {
      await db.close();
    }
  });

  it("the publication store persists the sender key and the lifecycle lookup returns it", async () => {
    const { db, messages, store, conversation } = await makeStack();
    try {
      const row = await messages.insert({
        conversationId: conversation.id,
        direction: "outgoing",
        logicalMessageId: "lm-key",
      });
      await store.setEnvelopeMessageId(row.id, "aa".repeat(16));
      expect((await store.findOutgoingByEnvelopeMessageId("aa".repeat(16)))?.receiptKey).toBeNull();
      await store.setReceiptKey(row.id, KEY);
      const found = await store.findOutgoingByEnvelopeMessageId("aa".repeat(16));
      expect(found?.recipientProfileIdHex).toBe("bb".repeat(32));
      expect(Array.from(found!.receiptKey!)).toEqual(Array.from(KEY));
    } finally {
      await db.close();
    }
  });
});
