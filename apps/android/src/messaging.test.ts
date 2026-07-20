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
import { CKB_TESTNET } from "@cemp/core";
import { EphemeralSoftwareKeyStore, MemoryVaultStorage, SecureVaultImpl } from "@cemp/secure-vault";
import { NodeSqliteAdapter } from "@cemp/database/node";
import { InMemoryScheduler } from "@cemp/sync";
import { NoopNotifier } from "@cemp/ui";
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
