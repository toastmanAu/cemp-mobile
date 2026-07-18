import { describe, expect, it } from "vitest";
import {
  ContactRepository,
  ConversationRepository,
  MessageRepository,
  migrate,
} from "@cemp/database";
import { NodeSqliteAdapter } from "@cemp/database/node";
import { messageBubbleState } from "./bubble.js";
import { ChatComposerViewModel } from "./composer.js";
import { CONTACT_EDIT_LIMITS, ContactEditModel, ContactListViewModel } from "./contact-list.js";
import { ConversationListViewModel } from "./conversation-list.js";
import { NOTIFICATION_CHANNELS, NoopNotifier } from "./notifier.js";

/**
 * Messenger-shell view-model tests (Phase 6 tasks 7–12). The conversation
 * list and composer flows run against REAL SQL through the Node `:memory:`
 * adapter — the exit criterion "local conversations work without blockchain
 * transport" is proven by nothing here importing any chain package.
 */
async function makeStack() {
  const db = new NodeSqliteAdapter();
  await migrate(db);
  const contacts = new ContactRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  return { db, contacts, conversations, messages };
}

describe("ConversationListViewModel", () => {
  it("lists conversations with previews and keeps a valid selection across refreshes", async () => {
    const { db, contacts, conversations, messages } = await makeStack();
    try {
      const alice = await contacts.create({ displayName: "alice" });
      const conv = await conversations.getOrCreateForContact(alice.id);
      await messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "hi",
        logicalMessageId: "x1",
      });

      const vm = new ConversationListViewModel(conversations);
      let notifications = 0;
      const unsubscribe = vm.subscribe(() => {
        notifications++;
      });
      await vm.refresh();
      expect(vm.items).toHaveLength(1);
      expect(vm.items[0]!.lastMessageBody).toBe("hi");
      expect(notifications).toBeGreaterThan(0);

      vm.select(conv.id);
      expect(vm.selected?.id).toBe(conv.id);

      // Selection drops when the conversation disappears from the list.
      await messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "2",
        logicalMessageId: "x2",
      });
      await db.run("DELETE FROM messages WHERE conversation_id = ?", [conv.id]);
      await db.run("DELETE FROM conversations WHERE id = ?", [conv.id]);
      await vm.refresh();
      expect(vm.selectedId).toBeNull();
      unsubscribe();
    } finally {
      await db.close();
    }
  });
});

describe("ContactListViewModel + ContactEditModel", () => {
  it("lists, searches, and saves validated edits", async () => {
    const { db, contacts } = await makeStack();
    try {
      await contacts.create({ displayName: "alice" });
      await contacts.create({ displayName: "bob" });
      const list = new ContactListViewModel(contacts);
      await list.refresh();
      expect(list.items).toHaveLength(2);
      await list.setQuery("ali");
      expect(list.items.map((c) => c.displayName)).toEqual(["alice"]);

      // Invalid: empty name, oversized notes, oversized avatar.
      const bad = new ContactEditModel(contacts);
      bad.displayName = "   ";
      bad.notes = "n".repeat(CONTACT_EDIT_LIMITS.maxNotesChars + 1);
      bad.avatar = new Uint8Array(CONTACT_EDIT_LIMITS.maxAvatarBytes + 1);
      const errors = bad.validate();
      expect(errors.map((e) => e.field).sort()).toEqual(["avatar", "displayName", "notes"]);
      await expect(bad.save()).rejects.toEqual(errors);

      // Valid create, then edit the same contact.
      const good = new ContactEditModel(contacts);
      good.displayName = " carol ";
      good.notes = "knows CKB";
      const id = await good.save();
      expect((await contacts.getById(id))?.displayName).toBe("carol");
      const edit = new ContactEditModel(contacts, (await contacts.getByIdWithAvatar(id))!);
      edit.displayName = "carol w";
      await edit.save();
      expect((await contacts.getById(id))?.displayName).toBe("carol w");

      // Profile id: validated (64 hex chars) and persisted on create.
      const badProfile = new ContactEditModel(contacts);
      badProfile.displayName = "dave";
      badProfile.profileIdHex = "not-hex";
      expect(badProfile.validate()).toEqual([{ field: "profileId", reason: "invalid" }]);
      const withProfile = new ContactEditModel(contacts);
      withProfile.displayName = "erin";
      withProfile.profileIdHex = "A".repeat(64);
      const erinId = await withProfile.save();
      expect((await contacts.getById(erinId))?.profileIdHex).toBe("a".repeat(64));
    } finally {
      await db.close();
    }
  });
});

describe("ChatComposerViewModel", () => {
  it("queues a trimmed message with an idempotent logical id and clears the draft", async () => {
    const { db, contacts, conversations, messages } = await makeStack();
    try {
      const alice = await contacts.create({ displayName: "alice" });
      const conv = await conversations.getOrCreateForContact(alice.id);
      const composer = new ChatComposerViewModel(messages, conv.id);

      expect(composer.canSend).toBe(false); // empty
      composer.setText("  hello alice  ");
      expect(composer.canSend).toBe(true);
      const sent = await composer.send();
      expect(sent).not.toBeUndefined();
      expect(sent!.state).toBe("queued");
      expect(sent!.body).toBe("hello alice");
      expect(sent!.logicalMessageId).toMatch(/^[0-9a-f]{32}$/);
      expect(composer.text).toBe("");
      expect(await messages.listByConversation(conv.id)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it("rejects oversized drafts (UTF-8 bytes, not characters) without losing the text", async () => {
    const { db, contacts, conversations, messages } = await makeStack();
    try {
      const alice = await contacts.create({ displayName: "alice" });
      const conv = await conversations.getOrCreateForContact(alice.id);
      const composer = new ChatComposerViewModel(messages, conv.id);
      // 16 KiB of "界" (3 UTF-8 bytes each) exceeds the 16,384-byte cap.
      composer.setText("界".repeat(6000));
      expect(composer.byteLength).toBe(18_000);
      expect(composer.canSend).toBe(false);
      expect(await composer.send()).toBeUndefined();
      expect(composer.status).not.toBe("sending");
      expect(composer.text.length).toBe(6000); // draft preserved for editing
      expect(await messages.listByConversation(conv.id)).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it("resumeDraft restores only outgoing drafts", async () => {
    const { db, contacts, conversations, messages } = await makeStack();
    try {
      const alice = await contacts.create({ displayName: "alice" });
      const conv = await conversations.getOrCreateForContact(alice.id);
      const draft = await messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: "draft body",
        logicalMessageId: "d1",
      });
      const composer = new ChatComposerViewModel(messages, conv.id);
      composer.resumeDraft(draft);
      expect(composer.text).toBe("draft body");
      const queued = await messages.transitionState(draft.id, "queued");
      expect(() => composer.resumeDraft(queued)).toThrow();
    } finally {
      await db.close();
    }
  });
});

describe("messageBubbleState", () => {
  it("maps outgoing states to user-facing statuses (no chain jargon)", () => {
    expect(messageBubbleState({ direction: "outgoing", state: "queued" })).toEqual({
      status: "sending",
      showSpinner: true,
      canRetry: false,
    });
    expect(messageBubbleState({ direction: "outgoing", state: "committed" }).status).toBe("sent");
    expect(
      messageBubbleState({ direction: "outgoing", state: "downloaded_by_recipient" }).status,
    ).toBe("delivered");
    expect(messageBubbleState({ direction: "outgoing", state: "acknowledged" }).status).toBe(
      "acknowledged",
    );
    expect(messageBubbleState({ direction: "outgoing", state: "failed" })).toEqual({
      status: "failed",
      showSpinner: false,
      canRetry: true,
    });
    expect(messageBubbleState({ direction: "outgoing", state: "reclaimed" }).status).toBe(
      "reclaimed",
    );
  });

  it("maps incoming states and stays neutral on unknown states", () => {
    expect(messageBubbleState({ direction: "incoming", state: "downloading" }).showSpinner).toBe(
      true,
    );
    expect(messageBubbleState({ direction: "incoming", state: "received" }).status).toBe(
      "received",
    );
    expect(messageBubbleState({ direction: "incoming", state: "invalid" }).status).toBe("invalid");
    // A state from a newer build renders a neutral bubble instead of crashing.
    expect(
      messageBubbleState({ direction: "incoming", state: "future_state" as never }).status,
    ).toBe("invalid");
  });
});

describe("Notifier", () => {
  it("declares the Android channel mapping and the no-op impl is silent", async () => {
    expect(NOTIFICATION_CHANNELS.map((c) => c.id)).toEqual(["messages", "sync-status"]);
    const notifier = new NoopNotifier();
    await expect(
      notifier.post({ id: "1", channel: "messages", title: "t", body: "b" }),
    ).resolves.toBeUndefined();
    await expect(notifier.cancel("1")).resolves.toBeUndefined();
  });
});
