/**
 * Application composition root (spec §4.2 service boundaries).
 *
 * Builds the platform seams (AsyncStorage vault storage, Android Keystore,
 * SQLCipher), opens the vault, and — once unlocked — opens the encrypted
 * database with the vault's database key and constructs the repositories the
 * screens bind to. Testnet-only by construction: all chain access goes
 * through `CKB_TESTNET` from @cemp/core (AGENTS.md rule 11).
 *
 * State model mirrors the vault: "loading" → "uninitialized" | "locked" →
 * "ready". A 1-second poll observes the vault's own auto-lock timer (spec
 * Phase 3 task 8) and tears the database down when it fires.
 */

import {
  ContactRepository,
  ConversationRepository,
  MessageRepository,
  AttachmentRepository,
  WatchedOutpointRepository,
  migrate,
} from "@cemp/database";
import { SecureVaultImpl } from "@cemp/secure-vault";
import type { Notifier } from "@cemp/ui";
import { AndroidKeychainKeyStore } from "./platform/android-keystore";
import { AndroidNotifier, requestNotificationPermission } from "./platform/android-notifier";
import { MessagingService } from "./messaging";
import { NativeKdfEngine } from "./platform/native-kdf";
import { OpSqlCipherAdapter } from "./platform/sqlcipher-adapter";
import { createRouteTagCache } from "./platform/route-tag-cache";
import { AsyncStorageVaultStorage } from "./platform/vault-storage";
import { WorkManagerScheduler } from "./platform/work-manager-scheduler";
import { bytesToHex } from "./platform/hex";

export type AppContainerState = "loading" | "uninitialized" | "locked" | "ready";

export interface AppRepositories {
  readonly contacts: ContactRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly attachments: AttachmentRepository;
  readonly watchedOutpoints: WatchedOutpointRepository;
}

export class AppContainer {
  readonly vault: SecureVaultImpl;
  readonly notifier: Notifier = new AndroidNotifier();

  #db: OpSqlCipherAdapter | null = null;
  #repositories: AppRepositories | null = null;
  #messaging: MessagingService | null = null;
  #state: AppContainerState = "loading";
  #listeners = new Set<() => void>();
  #poll: ReturnType<typeof setInterval> | null = null;

  static #current: AppContainer | null = null;

  /** The live container, when the app process is alive. */
  static current(): AppContainer | null {
    return AppContainer.#current;
  }

  private constructor(vault: SecureVaultImpl) {
    this.vault = vault;
  }

  static async init(): Promise<AppContainer> {
    const vault = await SecureVaultImpl.open({
      storage: new AsyncStorageVaultStorage(),
      keystore: new AndroidKeychainKeyStore(),
      // Native Bouncy Castle KDF — noble argon2/scrypt is unusably slow
      // under Hermes (see kdf.ts in cemp-secure-vault).
      kdfEngine: new NativeKdfEngine(),
    });
    const container = new AppContainer(vault);
    container.#setState(vault.state === "uninitialized" ? "uninitialized" : "locked");
    AppContainer.#current = container;
    return container;
  }

  get state(): AppContainerState {
    return this.#state;
  }

  get repositories(): AppRepositories {
    if (this.#repositories === null) {
      throw new Error("AppContainer: repositories are only available in the ready state");
    }
    return this.#repositories;
  }

  /** The P2P messaging service (publication + sync), ready-state only. */
  get messaging(): MessagingService {
    if (this.#messaging === null) {
      throw new Error("AppContainer: messaging is only available in the ready state");
    }
    return this.#messaging;
  }

  get hasMessaging(): boolean {
    return this.#messaging !== null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(state: AppContainerState): void {
    if (this.#state !== state) {
      this.#state = state;
      for (const listener of this.#listeners) {
        listener();
      }
    }
  }

  /** Call after any vault state-changing action (create/import/unlock). */
  async afterVaultUnlock(): Promise<void> {
    if (this.vault.state !== "unlocked") {
      this.#setState(this.vault.state === "uninitialized" ? "uninitialized" : "locked");
      return;
    }
    await this.#openDatabase();
    // Build the P2P messaging service (identity from the vault, pipelines over
    // the encrypted DB). Failures here leave the app usable for local data.
    if (this.#messaging === null && this.#db !== null) {
      this.#messaging = await MessagingService.init({
        vault: this.vault,
        db: this.#db,
        notifier: this.notifier,
        scheduler: new WorkManagerScheduler(),
      });
    }
    this.#setState("ready");
    this.#startPoll();
    void requestNotificationPermission();
    void this.#refreshRouteTags();
  }

  /** Cache route tags so the locked background probe has something to query. */
  async #refreshRouteTags(): Promise<void> {
    if (this.#messaging === null) {
      return;
    }
    try {
      await createRouteTagCache().writeTags(await this.#messaging.routeTagsHex());
    } catch {
      // A cache miss only costs locked-mode notifications; never fail unlock.
    }
  }

  async lock(): Promise<void> {
    this.#stopPoll();
    // Lock the vault BEFORE closing the database. `close()` now waits on the
    // transaction mutex so teardown cannot cut off an in-flight background
    // tick, and that wait is unbounded — if a native op-sqlite call ever
    // wedged, closing first would leave the vault unlocked with the key still
    // in memory. Locking first turns a driver hang into a stuck handle rather
    // than a security failure; in-flight work still drains against the handle,
    // which is already open and needs no key to close.
    await this.vault.lock();
    await this.#closeDatabase();
    this.#setState("locked");
  }

  /** Reset the vault's inactivity timer — any user interaction counts. */
  touch(): void {
    if (this.vault.state === "unlocked") {
      this.vault.touch();
    }
  }

  async wipe(): Promise<void> {
    this.#stopPoll();
    await this.#closeDatabase();
    // Stop the periodic tick BEFORE wiping: otherwise WorkManager keeps waking
    // a wiped identity and the locked probe keeps querying its route tags and
    // posting notifications for it. `cancelPeriodic()` is best-effort on its
    // own terms (WorkManagerScheduler swallows a missing native module or a
    // rejected native call, so its promise never rejects) — awaited here only
    // to sequence it ahead of the vault wipe below, never to gate it.
    await new WorkManagerScheduler().cancelPeriodic();
    // The route-tag cache is the ONE keystore artifact whose pointer lives
    // outside the vault file, so `vault.wipe()` (which deletes the vault file
    // and resets the default keychain service) does not make it unreachable.
    // Left alone, route tags and `lastSeen` outpoints — roughly three epochs
    // of inbox linkability — survive a factory wipe fully readable.
    try {
      await createRouteTagCache().clear();
    } catch {
      // Best effort; the vault wipe below must still happen.
    }
    await this.vault.wipe();
    this.#setState("uninitialized");
  }

  /** Observe the vault's auto-lock timer firing while the app is idle. */
  #startPoll(): void {
    this.#stopPoll();
    this.#poll = setInterval(() => {
      if (this.vault.state !== "unlocked") {
        void this.#handleExternalLock();
      }
    }, 1000);
  }

  #stopPoll(): void {
    if (this.#poll !== null) {
      clearInterval(this.#poll);
      this.#poll = null;
    }
  }

  async #handleExternalLock(): Promise<void> {
    this.#stopPoll();
    await this.#closeDatabase();
    this.#setState(this.vault.state === "uninitialized" ? "uninitialized" : "locked");
  }

  async #openDatabase(): Promise<void> {
    if (this.#db !== null) {
      return;
    }
    const dbKey = await this.vault.getDatabaseKey();
    try {
      this.#db = OpSqlCipherAdapter.open({
        name: "cemp.db",
        encryptionKeyHex: bytesToHex(dbKey),
      });
    } finally {
      // The adapter holds the key hex internally to op-sqlite; our local
      // borrow of the key bytes is wiped immediately.
      dbKey.fill(0);
    }
    await migrate(this.#db);
    this.#repositories = {
      contacts: new ContactRepository(this.#db),
      conversations: new ConversationRepository(this.#db),
      messages: new MessageRepository(this.#db),
      attachments: new AttachmentRepository(this.#db),
      watchedOutpoints: new WatchedOutpointRepository(this.#db),
    };
  }

  async #closeDatabase(): Promise<void> {
    // Wipe in-memory key material before tearing down state (rule 2).
    this.#messaging?.dispose();
    this.#messaging = null;
    this.#repositories = null;
    if (this.#db !== null) {
      await this.#db.close();
      this.#db = null;
    }
  }
}
