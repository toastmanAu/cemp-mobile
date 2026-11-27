import { describe, expect, it } from "vitest";
import { currentSchemaVersion, migrate } from "./migrate.js";
import { NodeSqliteAdapter } from "./node.js";
import { ContactRepository } from "./repositories/contacts.js";
import { ConversationRepository } from "./repositories/conversations.js";
import { IncomingDispositionRepository } from "./repositories/incoming-dispositions.js";
import { MessageRepository } from "./repositories/messages.js";

/**
 * ADR 0007 / schema v11: per-message sender authentication status and the
 * verifying key hash, the journaled signed outgoing envelope, and the
 * incoming disposition table that keeps deferred cells undisposed with a
 * bounded backoff.
 */
async function makeStack() {
  const db = new NodeSqliteAdapter();
  await migrate(db);
  const contacts = new ContactRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  const contact = await contacts.create({ displayName: "alice", profileIdHex: "aa".repeat(32) });
  const conversation = await conversations.getOrCreateForContact(contact.id);
  return { db, messages, conversation, dispositions: new IncomingDispositionRepository(db) };
}

describe("schema v11 (ADR 0007)", () => {
  it("migrates to v11 with the new columns and the disposition table", async () => {
    const db = new NodeSqliteAdapter();
    try {
      await migrate(db);
      expect(await currentSchemaVersion(db)).toBe(11);
      const cols = (await db.all("PRAGMA table_info(messages)")).map((c) => String(c.name));
      expect(cols).toEqual(
        expect.arrayContaining(["auth_status", "sender_key_hash_hex", "prepared_envelope"]),
      );
      const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
        (r) => String(r.name),
      );
      expect(tables).toContain("incoming_dispositions");
    } finally {
      await db.close();
    }
  });
});

describe("messages: sender authentication (per-message verifying key hash)", () => {
  it("new rows have no auth status; setSenderAuthentication records status + key hash", async () => {
    const { db, messages, conversation } = await makeStack();
    try {
      const row = await messages.insert({
        conversationId: conversation.id,
        direction: "incoming",
        body: "hi",
        logicalMessageId: "incoming:01",
      });
      expect(row.authStatus).toBeNull();
      expect(row.senderKeyHashHex).toBeNull();
      await messages.setSenderAuthentication(row.id, {
        authStatus: "verified",
        senderKeyHashHex: "ab".repeat(32),
      });
      const read = await messages.getById(row.id);
      expect(read?.authStatus).toBe("verified");
      expect(read?.senderKeyHashHex).toBe("ab".repeat(32));
      await messages.setSenderAuthentication(row.id, {
        authStatus: "legacy-unverified",
        senderKeyHashHex: null,
      });
      expect((await messages.getById(row.id))?.authStatus).toBe("legacy-unverified");
    } finally {
      await db.close();
    }
  });

  it("refuses an unknown auth status", async () => {
    const { db, messages, conversation } = await makeStack();
    try {
      const row = await messages.insert({
        conversationId: conversation.id,
        direction: "incoming",
        logicalMessageId: "incoming:02",
      });
      await expect(
        messages.setSenderAuthentication(row.id, {
          authStatus: "trusted-because-i-said-so" as never,
          senderKeyHashHex: null,
        }),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});

describe("messages: journaled prepared (signed) envelope", () => {
  it("round-trips; absent is undefined", async () => {
    const { db, messages, conversation } = await makeStack();
    try {
      const row = await messages.insert({
        conversationId: conversation.id,
        direction: "outgoing",
        logicalMessageId: "out:1",
        state: "queued",
      });
      expect(await messages.getPreparedEnvelope(row.id)).toBeUndefined();
      const prepared = {
        envelopeBytes: new Uint8Array([1, 2, 3]),
        routeTag: new Uint8Array(32).fill(7),
        conversationTag: new Uint8Array(16).fill(8),
        messageNonce: new Uint8Array(16).fill(9),
        messageId: new Uint8Array(16).fill(10),
      };
      await messages.setPreparedEnvelope(row.id, prepared);
      expect(await messages.getPreparedEnvelope(row.id)).toEqual(prepared);
    } finally {
      await db.close();
    }
  });
});

describe("incoming_dispositions", () => {
  const key = { txHash: `0x${"11".repeat(32)}`, outpointIndex: 0 };

  it("unknown → undefined; rejected and ingested are terminal records", async () => {
    const { db, dispositions } = await makeStack();
    try {
      expect(await dispositions.get(key)).toBeUndefined();
      await dispositions.markRejected(key, 1_000);
      expect((await dispositions.get(key))?.disposition).toBe("rejected");
      const other = { txHash: key.txHash, outpointIndex: 1 };
      await dispositions.markIngested(other, 1_000);
      expect((await dispositions.get(other))?.disposition).toBe("ingested");
    } finally {
      await db.close();
    }
  });

  it("deferred backs off exponentially and is capped", async () => {
    const { db, dispositions } = await makeStack();
    try {
      const first = await dispositions.markDeferred(key, 0);
      expect(first.attempts).toBe(1);
      expect(first.nextAttemptAtMs).toBe(IncomingDispositionRepository.BASE_BACKOFF_MS);
      const second = await dispositions.markDeferred(key, 0);
      expect(second.attempts).toBe(2);
      expect(second.nextAttemptAtMs).toBe(2 * IncomingDispositionRepository.BASE_BACKOFF_MS);
      let last = second;
      for (let i = 0; i < 40; i++) last = await dispositions.markDeferred(key, 0);
      expect(last.nextAttemptAtMs).toBe(IncomingDispositionRepository.MAX_BACKOFF_MS);
    } finally {
      await db.close();
    }
  });

  it("gives up after MAX_NOT_FOUND_DEFERRALS definite not-found answers", async () => {
    const { db, dispositions } = await makeStack();
    try {
      const limit = IncomingDispositionRepository.MAX_NOT_FOUND_DEFERRALS;
      let last;
      for (let i = 1; i < limit; i++) {
        last = await dispositions.markDeferred(key, 0, null, { notFound: true });
        expect(last.disposition).toBe("deferred");
      }
      last = await dispositions.markDeferred(key, 0, null, { notFound: true });
      expect(last.disposition).toBe("rejected");
      expect((await dispositions.get(key))?.disposition).toBe("rejected");
    } finally {
      await db.close();
    }
  });

  it("transport failures never count toward the not-found limit", async () => {
    const { db, dispositions } = await makeStack();
    try {
      const limit = IncomingDispositionRepository.MAX_NOT_FOUND_DEFERRALS;
      for (let i = 0; i < limit * 3; i++) {
        expect((await dispositions.markDeferred(key, 0)).disposition).toBe("deferred");
      }
      // one short of the limit, interleaved with transport failures: still deferred
      for (let i = 1; i < limit; i++) {
        await dispositions.markDeferred(key, 0, null, { notFound: true });
        await dispositions.markDeferred(key, 0);
      }
      expect((await dispositions.get(key))?.disposition).toBe("deferred");
      expect((await dispositions.markDeferred(key, 0, null, { notFound: true })).disposition).toBe(
        "rejected",
      );
    } finally {
      await db.close();
    }
  });

  it("stores LoRa objects (no outpoint) with their bytes and lists the due ones", async () => {
    const { db, dispositions } = await makeStack();
    try {
      const lora = { txHash: "lora:abcd", outpointIndex: -1 };
      await dispositions.markDeferred(lora, 0, new Uint8Array([5, 6]));
      expect(await dispositions.listDueDeferredWithData(0)).toEqual([]);
      const due = await dispositions.listDueDeferredWithData(
        IncomingDispositionRepository.BASE_BACKOFF_MS,
      );
      expect(due).toEqual([{ key: lora, cellData: new Uint8Array([5, 6]) }]);
    } finally {
      await db.close();
    }
  });
});
