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
import { describe, expect, it } from "vitest";
import { CempClient, type LiveCellStatus } from "@cemp/ckb";
import { CKB_TESTNET, codec } from "@cemp/core";
import { EphemeralSoftwareKeyStore, MemoryVaultStorage, SecureVaultImpl } from "@cemp/secure-vault";
import { ContactRepository, ConversationRepository, MessageRepository } from "@cemp/database";
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

    // FAKE client (task instruction): `CempClient#getLiveCell` is a plain
    // prototype method, and `MessagingService` builds its own `CempClient`
    // internally (not caller-injectable) — so the fake is installed as a
    // scoped prototype override, restored in `finally`, rather than passed
    // in as a constructor dependency.
    const originalGetLiveCell = CempClient.prototype.getLiveCell;
    CempClient.prototype.getLiveCell = function fakeGetLiveCell(): Promise<LiveCellStatus> {
      return Promise.resolve({
        status: "live",
        cell: { data: envelopeHex } as never,
      });
    };

    try {
      const derivedKey = await service.deriveIncomingAttachmentKey(row.id);
      expect(Array.from(derivedKey)).toEqual(Array.from(sendKey));
      expect(derivedKey.length).toBe(32);
    } finally {
      CempClient.prototype.getLiveCell = originalGetLiveCell;
      await db.close();
    }
  });
});
