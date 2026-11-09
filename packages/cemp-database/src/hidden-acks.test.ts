import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import { NodeSqliteAdapter } from "./node.js";
import { ContactRepository } from "./repositories/contacts.js";
import { ConversationRepository } from "./repositories/conversations.js";
import { MessageRepository } from "./repositories/messages.js";

/**
 * Receipt-only acknowledgement rows are internal: the envelope ack
 * (`response:`, 0x01) and the attachment-downloaded ack (`ack-attachment:`,
 * 0x05) are empty outgoing rows that must never appear as chat bubbles or as
 * the conversation preview. Device test 2026-11-09: tapping a received photo
 * queued the 0x05 ack and a blank bubble appeared on the receiver.
 */
describe("receipt-only ack rows are never shown", () => {
  async function stackWithAcks() {
    const db = new NodeSqliteAdapter();
    await migrate(db);
    const contacts = new ContactRepository(db);
    const conversations = new ConversationRepository(db);
    const messages = new MessageRepository(db);
    const contact = await contacts.create({ displayName: "alice", profileIdHex: "aa".repeat(32) });
    const conversation = await conversations.getOrCreateForContact(contact.id);
    await messages.insert({
      conversationId: conversation.id,
      direction: "incoming",
      body: "a photo for you",
      logicalMessageId: "incoming:01",
    });
    for (const prefix of ["response:", "ack-attachment:"]) {
      await messages.insert({
        conversationId: conversation.id,
        direction: "outgoing",
        body: "",
        logicalMessageId: `${prefix}incoming:01`,
      });
    }
    return { db, conversations, messages, conversation };
  }

  it("listByConversation hides both ack kinds (first page and paged)", async () => {
    const { db, messages, conversation } = await stackWithAcks();
    try {
      const shown = await messages.listByConversation(conversation.id);
      expect(shown.map((m) => m.logicalMessageId)).toEqual(["incoming:01"]);
      const paged = await messages.listByConversation(conversation.id, {
        beforeId: Number.MAX_SAFE_INTEGER,
      });
      expect(paged.map((m) => m.logicalMessageId)).toEqual(["incoming:01"]);
    } finally {
      await db.close();
    }
  });

  it("the conversation preview ignores ack rows", async () => {
    const { db, conversations } = await stackWithAcks();
    try {
      const [item] = await conversations.listWithPreview();
      expect(item?.lastMessageBody).toBe("a photo for you");
      expect(item?.lastMessageDirection).toBe("incoming");
    } finally {
      await db.close();
    }
  });
});
