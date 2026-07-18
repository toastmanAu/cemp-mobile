import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteAdapter } from "./adapter.js";
import { migrate } from "./migrate.js";
import { NodeSqliteAdapter } from "./node.js";
import { AttachmentRepository } from "./repositories/attachments.js";
import { ContactRepository } from "./repositories/contacts.js";
import { ConversationRepository } from "./repositories/conversations.js";
import { MessageRepository } from "./repositories/messages.js";
import { WatchedOutpointRepository } from "./repositories/watched-outpoints.js";

/**
 * Repository tests over the Node adapter (`:memory:` unless noted). These map
 * the Phase 6 exit criteria: local conversations with no chain transport,
 * restart persistence, and avatars/notes staying inside the DB layer.
 */
describe("repositories", () => {
  let db: SqliteAdapter;
  let contacts: ContactRepository;
  let conversations: ConversationRepository;
  let messages: MessageRepository;
  let attachments: AttachmentRepository;
  let outpoints: WatchedOutpointRepository;

  beforeEach(async () => {
    db = new NodeSqliteAdapter();
    await migrate(db);
    contacts = new ContactRepository(db);
    conversations = new ConversationRepository(db);
    messages = new MessageRepository(db);
    attachments = new AttachmentRepository(db);
    outpoints = new WatchedOutpointRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function makeContact(name = "alice") {
    return contacts.create({
      displayName: name,
      notes: "met at the meetup",
      profileIdHex: `profile-${name}`,
    });
  }

  it("contact CRUD, search, and avatar round-trip (bytes stay in the DB)", async () => {
    const alice = await makeContact();
    expect(alice.id).toBeGreaterThan(0);
    expect(alice.notes).toBe("met at the meetup");

    const avatar = new Uint8Array([1, 2, 3, 250, 251]);
    await contacts.setAvatar(alice.id, avatar);
    const withAvatar = await contacts.getByIdWithAvatar(alice.id);
    expect(withAvatar?.avatar).toEqual(avatar);
    // The plain list/get path does NOT drag avatar bytes along.
    const plain = await contacts.getById(alice.id);
    expect(plain).not.toHaveProperty("avatar");

    await contacts.update(alice.id, { displayName: "alice w", notes: "" });
    expect((await contacts.getById(alice.id))?.displayName).toBe("alice w");
    expect(await contacts.search("ALICE")).toHaveLength(1);
    expect(await contacts.search("bob")).toHaveLength(0);
    expect((await contacts.getByProfileId("profile-alice"))?.id).toBe(alice.id);

    await contacts.remove(alice.id);
    expect(await contacts.getById(alice.id)).toBeUndefined();
    await expect(contacts.remove(alice.id)).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects a duplicate profile id (UNIQUE constraint)", async () => {
    await makeContact("one");
    await expect(makeContact("one")).rejects.toMatchObject({ code: "constraint-violation" });
  });

  it("conversation is one-per-contact and idempotently created (rule 5)", async () => {
    const alice = await makeContact();
    const first = await conversations.getOrCreateForContact(alice.id);
    const again = await conversations.getOrCreateForContact(alice.id);
    expect(again.id).toBe(first.id);
  });

  it("message insert is idempotent on logical_message_id (rule 5)", async () => {
    const alice = await makeContact();
    const conv = await conversations.getOrCreateForContact(alice.id);
    const input = {
      conversationId: conv.id,
      direction: "outgoing" as const,
      body: "hello alice",
      logicalMessageId: "lm-0001",
    };
    const first = await messages.insert(input);
    const retried = await messages.insert(input);
    expect(retried.id).toBe(first.id);
    expect(await messages.listByConversation(conv.id)).toHaveLength(1);
  });

  it("conversation list: one query, preview + unread, ordered by activity", async () => {
    const alice = await makeContact("alice");
    const bob = await makeContact("bob");
    const convAlice = await conversations.getOrCreateForContact(alice.id);
    const convBob = await conversations.getOrCreateForContact(bob.id);

    await messages.insert({
      conversationId: convAlice.id,
      direction: "incoming",
      body: "hi",
      logicalMessageId: "a1",
      createdAtMs: 1000,
    });
    await messages.insert({
      conversationId: convAlice.id,
      direction: "incoming",
      body: "you there?",
      logicalMessageId: "a2",
      createdAtMs: 2000,
    });
    await messages.insert({
      conversationId: convBob.id,
      direction: "outgoing",
      body: "hey bob",
      logicalMessageId: "b1",
      createdAtMs: 3000,
    });
    // Deterministic activity ordering: alice's conversation is the newest.
    await conversations.touch(convAlice.id, Date.now() + 60_000);

    const list = await conversations.listWithPreview();
    expect(list).toHaveLength(2);
    expect(list[0]!.contactDisplayName).toBe("alice");
    expect(list[0]!.lastMessageBody).toBe("you there?");
    expect(list[0]!.lastMessageDirection).toBe("incoming");
    // Incoming inserts start at `discovered` — nothing has reached `received`
    // yet, so the unread badge is 0 (see the dedicated unread test below).
    expect(list[0]!.unreadCount).toBe(0);
    expect(list[1]!.contactDisplayName).toBe("bob");
    expect(list[1]!.lastMessageBody).toBe("hey bob");
    expect(list[1]!.lastMessageState).toBe("draft");
    expect(list[1]!.unreadCount).toBe(0);
  });

  it("unread count tracks received → displayed transitions", async () => {
    const alice = await makeContact();
    const conv = await conversations.getOrCreateForContact(alice.id);
    const m = await messages.insert({
      conversationId: conv.id,
      direction: "incoming",
      body: "ping",
      logicalMessageId: "u1",
    });
    expect(await messages.countUnread(conv.id)).toBe(0); // still `discovered`
    await messages.transitionState(m.id, "downloading");
    await messages.transitionState(m.id, "decrypting");
    await messages.transitionState(m.id, "received");
    expect(await messages.countUnread(conv.id)).toBe(1);
    await messages.transitionState(m.id, "displayed");
    expect(await messages.countUnread(conv.id)).toBe(0);
  });

  it("state transitions: legal path, illegal throw, same-state idempotent no-op (§11)", async () => {
    const alice = await makeContact();
    const conv = await conversations.getOrCreateForContact(alice.id);
    const m = await messages.insert({
      conversationId: conv.id,
      direction: "outgoing",
      body: "x",
      logicalMessageId: "s1",
    });
    expect(m.state).toBe("draft");

    await expect(messages.transitionState(m.id, "pending")).rejects.toMatchObject({
      code: "illegal-state-transition",
    });
    await messages.transitionState(m.id, "queued");
    const reapplied = await messages.transitionState(m.id, "queued"); // no-op
    expect(reapplied.state).toBe("queued");
    await messages.transitionState(m.id, "encrypting");
    await messages.transitionState(m.id, "failed");
    await expect(messages.transitionState(m.id, "queued")).rejects.toMatchObject({
      code: "illegal-state-transition",
    });
    await expect(messages.transitionState(999_999, "queued")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("keyset pagination over a conversation is stable and complete", async () => {
    const alice = await makeContact();
    const conv = await conversations.getOrCreateForContact(alice.id);
    for (let i = 0; i < 12; i++) {
      await messages.insert({
        conversationId: conv.id,
        direction: "outgoing",
        body: `m${String(i)}`,
        logicalMessageId: `p${String(i)}`,
      });
    }
    const page1 = await messages.listByConversation(conv.id, { limit: 5 });
    const page2 = await messages.listByConversation(conv.id, { limit: 5, beforeId: page1[4]!.id });
    const page3 = await messages.listByConversation(conv.id, { limit: 5, beforeId: page2[4]!.id });
    const bodies = [...page1, ...page2, ...page3].map((m) => m.body);
    expect(bodies).toEqual([
      "m11",
      "m10",
      "m9",
      "m8",
      "m7",
      "m6",
      "m5",
      "m4",
      "m3",
      "m2",
      "m1",
      "m0",
    ]);
  });

  it("chain refs upsert and read back", async () => {
    const alice = await makeContact();
    const conv = await conversations.getOrCreateForContact(alice.id);
    const m = await messages.insert({
      conversationId: conv.id,
      direction: "outgoing",
      body: "x",
      logicalMessageId: "c1",
    });
    await messages.setChainRef(m.id, { txHash: "0xaa", outpointIndex: 0 });
    let ref = await messages.getChainRef(m.id);
    expect(ref?.txHash).toBe("0xaa");
    expect(ref?.replyToTxHash).toBeNull();
    await messages.setChainRef(m.id, {
      txHash: "0xbb",
      outpointIndex: 1,
      replyToTxHash: "0xaa",
      replyToOutpointIndex: 0,
    });
    ref = await messages.getChainRef(m.id);
    expect(ref?.txHash).toBe("0xbb");
    expect(ref?.replyToTxHash).toBe("0xaa");
  });

  it("attachment + chunk bookkeeping", async () => {
    const alice = await makeContact();
    const conv = await conversations.getOrCreateForContact(alice.id);
    const m = await messages.insert({
      conversationId: conv.id,
      direction: "outgoing",
      body: "img",
      logicalMessageId: "att1",
    });
    const att = await attachments.create({
      messageId: m.id,
      kind: "image/webp",
      byteLength: 400_000,
      manifest: new Uint8Array([9, 9]),
    });
    expect(att.state).toBe("pending");
    await attachments.registerChunk({
      attachmentId: att.id,
      chunkIndex: 0,
      outpointTxHash: "0x01",
      outpointIndex: 0,
      state: "on_chain",
    });
    await attachments.registerChunk({
      attachmentId: att.id,
      chunkIndex: 0,
      outpointTxHash: "0x01",
      outpointIndex: 0,
      state: "on_chain",
    }); // idempotent re-register
    const chunks = await attachments.listChunks(att.id);
    expect(chunks).toHaveLength(1);
    await attachments.setChunkState(att.id, 0, "acked");
    expect((await attachments.listChunks(att.id))[0]!.state).toBe("acked");
    expect(await attachments.listForMessage(m.id)).toHaveLength(1);
  });

  it("watched outpoints: register idempotent, mark-spent idempotent + conflict throws", async () => {
    const watch = await outpoints.register({
      txHash: "0xdead",
      outpointIndex: 3,
      purpose: "message-ack",
    });
    const again = await outpoints.register({
      txHash: "0xdead",
      outpointIndex: 3,
      purpose: "message-ack",
    });
    expect(again.id).toBe(watch.id);
    expect(await outpoints.listActive()).toHaveLength(1);

    const spent = await outpoints.markSpent("0xdead", 3, "0xbeef");
    expect(spent.status).toBe("spent");
    expect(await outpoints.listActive()).toHaveLength(0);
    const respent = await outpoints.markSpent("0xdead", 3, "0xbeef"); // same spender: no-op
    expect(respent.spentByTxHash).toBe("0xbeef");
    await expect(outpoints.markSpent("0xdead", 3, "0xcafe")).rejects.toMatchObject({
      code: "constraint-violation",
    });
    await expect(outpoints.markSpent("0x00", 0, "0x01")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("restart persistence: state survives close/reopen on a file database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cemp-db-restart-"));
    const path = join(dir, "app.sqlite");
    try {
      const first = new NodeSqliteAdapter({ path });
      await migrate(first);
      const c1 = new ContactRepository(first);
      const v1 = new ConversationRepository(first);
      const m1 = new MessageRepository(first);
      const contact = await c1.create({
        displayName: "persistent",
        notes: "secret notes",
        avatar: new Uint8Array([7, 7, 7]),
      });
      const conv = await v1.getOrCreateForContact(contact.id);
      const msg = await m1.insert({
        conversationId: conv.id,
        direction: "incoming",
        body: "kept across restarts",
        logicalMessageId: "r1",
      });
      await m1.transitionState(msg.id, "downloading");
      await first.close();

      const second = new NodeSqliteAdapter({ path });
      await migrate(second);
      const m2 = new MessageRepository(second);
      const c2 = new ContactRepository(second);
      const restored = await m2.getByLogicalId("r1");
      expect(restored?.body).toBe("kept across restarts");
      expect(restored?.state).toBe("downloading");
      const restoredContact = await c2.getByIdWithAvatar(contact.id);
      expect(restoredContact?.notes).toBe("secret notes");
      expect(restoredContact?.avatar).toEqual(new Uint8Array([7, 7, 7]));
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("public surface exposes no plaintext export/dump API (task 13)", async () => {
    const mod = await import("./index.js");
    const forbidden = /export|dump|backup|plaintext/i;
    for (const name of Object.keys(mod)) {
      expect(forbidden.test(name), `unexpected export: ${name}`).toBe(false);
    }
  });
});

describe("block/report controls (Phase 11 task 10)", () => {
  it("block flag round-trips, unknown profiles are unblocked, report records a security event", async () => {
    const db = new NodeSqliteAdapter();
    await migrate(db);
    try {
      const contacts = new ContactRepository(db);
      const alice = await contacts.create({ displayName: "alice", profileIdHex: "0xalice" });
      expect(await contacts.isBlocked(alice.id)).toBe(false);
      expect(await contacts.isBlockedByProfileId("0xalice")).toBe(false);
      expect(await contacts.isBlockedByProfileId("0xunknown")).toBe(false);

      await contacts.setBlocked(alice.id, true);
      expect(await contacts.isBlocked(alice.id)).toBe(true);
      expect(await contacts.isBlockedByProfileId("0xalice")).toBe(true);
      // History is untouched by blocking (rule 8).
      expect((await contacts.getById(alice.id))?.displayName).toBe("alice");

      await contacts.report(alice.id, "spam flood from this profile");
      const events = await db.all("SELECT * FROM security_events WHERE kind = ?", [
        "contact_reported",
      ]);
      expect(events).toHaveLength(1);
      expect(String(events[0]!.detail)).toBe("spam flood from this profile");

      await contacts.setBlocked(alice.id, false);
      expect(await contacts.isBlocked(alice.id)).toBe(false);
      await expect(contacts.setBlocked(999_999, true)).rejects.toMatchObject({ code: "not-found" });
    } finally {
      await db.close();
    }
  });
});
