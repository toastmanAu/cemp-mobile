/**
 * Regression guard for the Phase 9 background-operation gap found on-device
 * (task 8): `MessagingService.init` built a `SyncEngine` and threw away the
 * fact that nobody had called `start()` on it, so no WorkManager job was ever
 * enqueued — the app only ever synced in the foreground.
 *
 * `messaging.ts` has no React Native import (directly or transitively: every
 * value it imports from `@cemp/*` is either a runtime-free package or an
 * `import type`), so — unlike `app-container.ts`, which pulls in the Android
 * platform seams (Keystore, WorkManager, op-sqlite, AsyncStorage) and cannot
 * be loaded under vitest — this file's real composition root, `init()`, can
 * be exercised directly. This test builds a genuinely unlocked vault
 * (`MemoryVaultStorage` + `EphemeralSoftwareKeyStore`, the same fixtures
 * `@cemp/secure-vault`'s own test suite uses) and a real in-memory database
 * (`NodeSqliteAdapter`, the same one `@cemp/database`'s suite uses), then
 * calls the actual `MessagingService.init` used in production and asserts
 * the scheduler was told to register periodic work. If the `engine.start()`
 * call in `init()` is ever deleted again, this test fails.
 */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CempClient, MessagePublisher, type LiveCellStatus } from "@cemp/ckb";
import { CKB_TESTNET, codec, decodeContactBundle, encodeContactBundle } from "@cemp/core";
import { EphemeralSoftwareKeyStore, MemoryVaultStorage, SecureVaultImpl } from "@cemp/secure-vault";
import {
  AttachmentRepository,
  ContactRepository,
  ConversationRepository,
  MessageRepository,
  OutgoingTransactionRepository,
  ProfileRepository,
} from "@cemp/database";
import { NodeSqliteAdapter } from "@cemp/database/node";
import { InMemoryScheduler } from "@cemp/sync";
import { NoopNotifier } from "@cemp/ui";
import {
  deriveIdentityKeys,
  deriveSendAttachmentKey,
  encryptEnvelope,
  randomBytes,
} from "@cemp/crypto";
import { MessagingService } from "./messaging";

/** Tiny KDF so vault creation stays fast in tests (mirrors vault.test.ts). */
const TINY_KDF = { alg: "argon2id", m: 8, t: 1, p: 1 } as const;

async function unlockedTestVault(): Promise<SecureVaultImpl> {
  const vault = await SecureVaultImpl.open({
    storage: new MemoryVaultStorage(),
    keystore: new EphemeralSoftwareKeyStore(),
  });
  // createWithNewMnemonic ends in the unlocked state.
  await vault.createWithNewMnemonic(12, "messaging-test-password", { kdf: TINY_KDF });
  return vault;
}

/**
 * Build a real `MessagingService` (same composition `init()` uses everywhere
 * else in this file) and, when `publishedProfile` is given, seed an active
 * profile row directly through `ProfileRepository` — the same repository
 * `myProfileId`/`myFingerprint` read from — so the service observes a
 * published profile without needing a real on-chain publish. The DB is
 * closed automatically at the end of the test.
 */
async function makeTestService(opts: {
  publishedProfile: string | null;
}): Promise<MessagingService> {
  const vault = await unlockedTestVault();
  const db = new NodeSqliteAdapter();
  onTestFinished(() => db.close());
  const service = await MessagingService.init({
    vault,
    db,
    notifier: new NoopNotifier(),
    scheduler: new InMemoryScheduler(),
  });
  if (opts.publishedProfile !== null) {
    const accountRow = await db.get("SELECT id FROM accounts LIMIT 1");
    const accountId = Number(accountRow!.id);
    await new ProfileRepository(db).create({
      accountId,
      profileIdHex: opts.publishedProfile,
      typeIdHex: opts.publishedProfile,
      state: "active",
    });
  }
  return service;
}

describe("MessagingService.init background scheduling", () => {
  it("registers the sync engine's workers with the scheduler (Phase 9 exit criterion)", async () => {
    expect(CKB_TESTNET.deployments.mlDsaLock).not.toBeNull();
    expect(CKB_TESTNET.deployments.cempMessageType).not.toBeNull();

    const vault = await unlockedTestVault();
    const db = new NodeSqliteAdapter();
    const scheduler = new InMemoryScheduler();

    await MessagingService.init({
      vault,
      db,
      notifier: new NoopNotifier(),
      scheduler,
    });

    // Regression check: before the fix, `SyncEngine.start()` was never
    // called anywhere, so this map stayed empty and no background sync was
    // ever scheduled on-device (confirmed via `dumpsys jobscheduler`).
    expect(scheduler.periodic.size).toBeGreaterThan(0);

    // Every worker registers a periodic request with the same real
    // scheduler; buildWorkerSpecs currently wires up 8 (pending-transactions,
    // incoming-discovery, response-sender, watched-outpoints, reclaim-batch,
    // balance-refresh, profile-refresh, database-maintenance). The count
    // itself is incidental — the coalescing adapter (scheduler-coalesce.ts,
    // covered separately) is what turns these into exactly one WorkManager
    // job; this test only proves registration happens at all.
    expect(scheduler.periodic.size).toBe(8);

    await db.close();
  });
});

describe("MessagingService.deriveIncomingAttachmentKey (Task 15a receive-side crux)", () => {
  it("prefers the key persisted at discovery (schema v8) — no chain call, returns a wipe-safe copy", async () => {
    const vault = await unlockedTestVault();
    const db = new NodeSqliteAdapter();
    const scheduler = new InMemoryScheduler();

    const service = await MessagingService.init({
      vault,
      db,
      notifier: new NoopNotifier(),
      scheduler,
    });

    // A post-v8 incoming image row: the discovery worker stored the
    // envelope-derived key alongside the manifest.
    const contacts = new ContactRepository(db);
    const conversations = new ConversationRepository(db);
    const messages = new MessageRepository(db);
    const attachments = new AttachmentRepository(db);
    const contact = await contacts.create({ displayName: "sender", profileIdHex: "9".repeat(64) });
    const conversation = await conversations.getOrCreateForContact(contact.id);
    const row = await messages.insert({
      conversationId: conversation.id,
      direction: "incoming",
      body: "",
      logicalMessageId: "stored-attachment-key-test",
    });
    const storedKey = randomBytes(32);
    await attachments.create({
      messageId: row.id,
      kind: "image",
      byteLength: 100,
      attachmentKey: storedKey,
    });

    // The stored key must resolve WITHOUT touching the chain — the whole
    // point of the fix is that the sender may have reclaimed the message
    // cell (rule 9), so getLiveCell would be useless here anyway.
    const spy = vi.spyOn(CempClient.prototype, "getLiveCell");
    onTestFinished(() => {
      spy.mockRestore();
    });

    try {
      const derivedKey = await service.deriveIncomingAttachmentKey(row.id);
      expect(spy).not.toHaveBeenCalled();
      expect(Array.from(derivedKey)).toEqual(Array.from(storedKey));
      // The returned buffer is a COPY: downloadImageAttachment wipes it in
      // `finally`, and that wipe must not zero the persisted key.
      derivedKey.fill(0);
      const secondRead = await service.deriveIncomingAttachmentKey(row.id);
      expect(Array.from(secondRead)).toEqual(Array.from(storedKey));
      secondRead.fill(0);
    } finally {
      await db.close();
    }
  });

  it("re-derives the byte-identical attachment key the sender used, from a real stored envelope", async () => {
    const vault = await unlockedTestVault();
    const db = new NodeSqliteAdapter();
    const scheduler = new InMemoryScheduler();

    // The receiving device's real ML-KEM keypair — derived deterministically
    // from the SAME vault seed `MessagingService.init` will use internally
    // (proven equal in @cemp/secure-vault's own suite), so encrypting to
    // `bundle.mlKem.publicKey` here is encrypting to exactly the secret key
    // `deriveIncomingAttachmentKey` will decrypt with.
    const bundle = await vault.withUnlockedSeed((seed) => deriveIdentityKeys(seed));

    const service = await MessagingService.init({
      vault,
      db,
      notifier: new NoopNotifier(),
      scheduler,
    });

    // Fresh vault, no published profile: `MessagingService`'s own profile id
    // (used as `ownProfileId` on decrypt) defaults to 32 zero bytes — mirror
    // that as the envelope's recipient_profile_id so decryption's implicit
    // AEAD binding check succeeds.
    const ownProfileId = new Uint8Array(32);
    const senderProfileId = new Uint8Array(32).fill(9);
    const messageId = new Uint8Array(16).fill(4);
    const kemMessage = randomBytes(32);
    const nonce = randomBytes(12);

    // Same-KEM-encapsulation seam (spec §6/§9.2): the sender derives the
    // attachment key from the SAME kemMessage+nonce it feeds encryptEnvelope.
    const sendKey = deriveSendAttachmentKey({
      recipientKemPublicKey: bundle.mlKem.publicKey,
      kemMessage,
      nonce,
      senderProfileId,
      recipientProfileId: ownProfileId,
    });

    const payload = codec.encodeCempPayloadV1({
      message_id: messageId,
      body_type: 0x03,
      recipient_profile_id: ownProfileId,
      attachment_manifests: [],
      receipts: [],
      receipt_request: 0,
      client_timestamp: 0n,
      sender_device_id: new Uint8Array(16).fill(7),
      padding: new Uint8Array(0),
    });
    const header: codec.CempEnvelopeHeaderV1Encodable = {
      protocol_version: 1,
      network: 0x01,
      content_type: 0x03,
      message_id: messageId,
      conversation_id: new Uint8Array(32).fill(3),
      sender_profile_id: senderProfileId,
      created_at_client: 0n,
      expiry_hint: 0n,
    };
    const env = encryptEnvelope({
      payload,
      recipientKemPublicKey: bundle.mlKem.publicKey,
      header,
      kemMessage,
      nonce,
    });
    const envelopeHex = `0x${Array.from(env.envelopeBytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

    // Persist a real incoming message row + chain ref (the read path
    // `deriveIncomingAttachmentKey` actually walks), pointing at a fake
    // outpoint — the FAKE client below serves that outpoint's cell data as
    // the envelope we just built.
    const contacts = new ContactRepository(db);
    const conversations = new ConversationRepository(db);
    const messages = new MessageRepository(db);
    const contact = await contacts.create({ displayName: "sender", profileIdHex: "9".repeat(64) });
    const conversation = await conversations.getOrCreateForContact(contact.id);
    const row = await messages.insert({
      conversationId: conversation.id,
      direction: "incoming",
      body: "",
      logicalMessageId: "task15a-attachment-key-test",
    });
    const fakeTxHash = `0x${"ab".repeat(32)}`;
    await messages.setChainRef(row.id, { txHash: fakeTxHash, outpointIndex: 0 });
    // Legacy pre-v8 row shape: an attachment row exists (manifest stored at
    // discovery) but its attachment_key is NULL — the stored-key path must
    // pass it by and fall back to chain re-derivation.
    await new AttachmentRepository(db).create({
      messageId: row.id,
      kind: "image",
      byteLength: 100,
      manifest: new Uint8Array([1]),
    });

    // FAKE client (task instruction): `CempClient#getLiveCell` is a plain
    // prototype method, and `MessagingService` builds its own `CempClient`
    // internally (not caller-injectable) — so the fake is installed as a
    // scoped prototype override. `onTestFinished` guarantees the restore even
    // if the test body dies mid-flight (review follow-up).
    const spy = vi
      .spyOn(CempClient.prototype, "getLiveCell")
      .mockImplementation((): Promise<LiveCellStatus> =>
        Promise.resolve({
          status: "live",
          cell: { data: envelopeHex } as never,
        }),
      );
    onTestFinished(() => {
      spy.mockRestore();
    });

    try {
      const derivedKey = await service.deriveIncomingAttachmentKey(row.id);
      expect(Array.from(derivedKey)).toEqual(Array.from(sendKey));
      expect(derivedKey.length).toBe(32);
      // No stored key on the legacy row → the chain re-derivation ran.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });
});

describe("MessagingService.publishImage desync guard (retry after broadcast)", () => {
  /**
   * A journaled `message:<logicalMessageId>` record in submitted/committed
   * state means attempt 1 already broadcast the manifest message tx naming
   * the attempt-1 chunks. A retry must skip the chunk pipeline (re-uploading
   * under a new key would orphan the new chunks) and only drive the
   * publisher's resume path — and must NOT rewrite the attachments row.
   */
  async function guardedService(state: "submitted" | "committed") {
    const vault = await unlockedTestVault();
    const db = new NodeSqliteAdapter();
    // No createImageCodec on purpose: reaching the chunk path would throw
    // "no image codec configured", so a passing test proves the guard
    // short-circuited BEFORE any chunk work.
    const service = await MessagingService.init({
      vault,
      db,
      notifier: new NoopNotifier(),
      scheduler: new InMemoryScheduler(),
    });
    const outgoingTxs = new OutgoingTransactionRepository(db);
    await outgoingTxs.record({
      txHash: `0x${"cd".repeat(32)}`,
      purpose: "message:img-logical-1",
      state,
      submittedAtMs: Date.now(),
    });
    return { db, service };
  }

  it.each(["submitted", "committed"] as const)(
    "skips chunk work and resumes via publishText when the message tx is %s",
    async (state) => {
      const { db, service } = await guardedService(state);
      const publishText = vi.spyOn(MessagePublisher.prototype, "publishText").mockResolvedValue({
        txHash: `0x${"cd".repeat(32)}`,
        outPoint: { txHash: `0x${"cd".repeat(32)}`, index: 0 },
        committed: true,
        resumed: true,
      });
      onTestFinished(() => {
        publishText.mockRestore();
      });

      try {
        const result = await service.publishImage({
          messageRowId: 1,
          logicalMessageId: "img-logical-1",
          recipientProfileIdHex: "ab".repeat(32),
          sourceBytes: new Uint8Array([1, 2, 3]),
          caption: "hello",
        });

        expect(result.messageTxHash).toBe(`0x${"cd".repeat(32)}`);
        expect(publishText).toHaveBeenCalledTimes(1);
        expect(publishText).toHaveBeenCalledWith({
          messageRowId: 1,
          logicalMessageId: "img-logical-1",
          text: "hello",
          recipientProfileIdHex: "ab".repeat(32),
          receiptRequest: 1,
        });
      } finally {
        await db.close();
      }
    },
  );

  it("defaults the resume text to an empty caption", async () => {
    const { db, service } = await guardedService("submitted");
    const publishText = vi.spyOn(MessagePublisher.prototype, "publishText").mockResolvedValue({
      txHash: `0x${"cd".repeat(32)}`,
      outPoint: { txHash: `0x${"cd".repeat(32)}`, index: 0 },
      committed: true,
      resumed: true,
    });
    onTestFinished(() => {
      publishText.mockRestore();
    });

    try {
      await service.publishImage({
        messageRowId: 1,
        logicalMessageId: "img-logical-1",
        recipientProfileIdHex: "ab".repeat(32),
        sourceBytes: new Uint8Array([1, 2, 3]),
      });
      expect(publishText).toHaveBeenCalledWith(
        expect.objectContaining({ text: "" }) as unknown as Record<string, unknown>,
      );
    } finally {
      await db.close();
    }
  });
});

describe("myContactBundle", () => {
  it("returns null when no profile has been published", async () => {
    const service = await makeTestService({ publishedProfile: null });
    expect(await service.myContactBundle()).toBeNull();
  });

  it("composes a testnet bundle from the published profile", async () => {
    const service = await makeTestService({ publishedProfile: "aa".repeat(32) });
    const bundle = await service.myContactBundle();

    expect(bundle).not.toBeNull();
    expect(bundle!.network).toBe("ckb_testnet");
    expect(bundle!.profileTypeId).toBe(`0x${"aa".repeat(32)}`);
    expect(bundle!.lockScriptHash).toBe(service.identity().lockScriptHash);
    expect(bundle!.address).toBe(service.identity().address);
    expect(bundle!.fingerprint).toBe(await service.myFingerprint());
  });

  it("produces a bundle the existing decoder accepts", async () => {
    const service = await makeTestService({ publishedProfile: "bb".repeat(32) });
    const bundle = await service.myContactBundle();
    expect(decodeContactBundle(encodeContactBundle(bundle!))).toEqual(bundle);
  });
});
