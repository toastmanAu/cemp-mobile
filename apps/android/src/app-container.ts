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
import { NoopNotifier, type Notifier } from "@cemp/ui";
import { AndroidKeychainKeyStore } from "./platform/android-keystore";
import { MessagingService } from "./messaging";
import { NativeKdfEngine } from "./platform/native-kdf";
import { OpSqlCipherAdapter } from "./platform/sqlcipher-adapter";
import { AsyncStorageVaultStorage } from "./platform/vault-storage";

export type AppContainerState = "loading" | "uninitialized" | "locked" | "ready";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AppRepositories {
  readonly contacts: ContactRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly attachments: AttachmentRepository;
  readonly watchedOutpoints: WatchedOutpointRepository;
}

export class AppContainer {
  readonly vault: SecureVaultImpl;
  readonly notifier: Notifier = new NoopNotifier();

  #db: OpSqlCipherAdapter | null = null;
  #repositories: AppRepositories | null = null;
  #messaging: MessagingService | null = null;
  #state: AppContainerState = "loading";
  #listeners = new Set<() => void>();
  #poll: ReturnType<typeof setInterval> | null = null;

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
      });
    }
    this.#setState("ready");
    this.#startPoll();
  }

  async lock(): Promise<void> {
    this.#stopPoll();
    await this.#closeDatabase();
    await this.vault.lock();
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
