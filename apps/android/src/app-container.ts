/**
 * Application composition root (spec §4.2 service boundaries).
 *
 * Builds the platform seams (AsyncStorage vault storage, the platform
 * keystore, SQLCipher — see platform/seams.ts), opens the vault, and — once
 * unlocked — opens the encrypted database with the vault's database key and
 * constructs the repositories the screens bind to. Testnet-only by
 * construction: all chain access goes through `CKB_TESTNET` from @cemp/core
 * (AGENTS.md rule 11).
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
  LocalSettingsRepository,
  migrate,
} from "@cemp/database";
import { SecureVaultImpl } from "@cemp/secure-vault";
import type { Notifier } from "@cemp/ui";
import { MessagingService } from "./messaging";
import { pickImage } from "./platform/native-image-picker";
import { scanImageForQr, scanWithCamera } from "./platform/native-qr-scanner";
import { OpSqlCipherAdapter } from "./platform/sqlcipher-adapter";
import { shareImage } from "./platform/native-share";
import { createRouteTagCache } from "./platform/route-tag-cache";
import { platformSeams } from "./platform/seams";
import type { PlatformSeams } from "./platform/seams-core";
import { AsyncStorageVaultStorage } from "./platform/vault-storage";
import { bytesToHex } from "./platform/hex";
import { isVaultUsable } from "./vault-liveness";
import { ForegroundSync, IDLE_CADENCE_MS } from "./foreground-sync";
import { AppState, type NativeEventSubscription } from "react-native";

export type AppContainerState = "loading" | "uninitialized" | "locked" | "ready";

/**
 * Result of {@link AppContainer.scanContactFromPhoto}, distinguishing three
 * outcomes that collapsing into one `null` used to hide from the user:
 * the photo picker was cancelled (silent — the user changed their mind),
 * a photo was chosen but no QR code was found in it (its own message —
 * "No contact code found in that image.", per the design spec's
 * error-handling table), and a code was found (carries the decoded text
 * onward to classification). Collapsing "cancelled" and "no-code" was the
 * plan's original design; it is wrong here for the same reason the
 * 2026-07-29 vault bug is in this file's own doc comment — a photo with no
 * code in it left the button flickering with no feedback at all.
 */
export type ScanFromPhotoResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "no-code" }
  | { readonly kind: "text"; readonly text: string };

/**
 * The local encrypted database. Named in ONE place because open and destroy
 * must agree: a destroy that misses the file leaves it for the next wallet,
 * which cannot decrypt it (the 2026-07-29 device bug).
 */
const DATABASE_NAME = "cemp.db";

export interface AppRepositories {
  readonly contacts: ContactRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly attachments: AttachmentRepository;
  readonly watchedOutpoints: WatchedOutpointRepository;
  readonly localSettings: LocalSettingsRepository;
}

export class AppContainer {
  readonly vault: SecureVaultImpl;
  readonly notifier: Notifier;

  #seams: PlatformSeams;
  #db: OpSqlCipherAdapter | null = null;
  #repositories: AppRepositories | null = null;
  #messaging: MessagingService | null = null;
  #state: AppContainerState = "loading";
  #listeners = new Set<() => void>();
  #poll: ReturnType<typeof setInterval> | null = null;
  #foregroundSync: ForegroundSync | null = null;
  #appStateSub: NativeEventSubscription | null = null;

  static #current: AppContainer | null = null;

  /** The live container, when the app process is alive. */
  static current(): AppContainer | null {
    return AppContainer.#current;
  }

  private constructor(vault: SecureVaultImpl, seams: PlatformSeams) {
    this.vault = vault;
    this.#seams = seams;
    this.notifier = seams.createNotifier();
  }

  static async init(): Promise<AppContainer> {
    const seams = platformSeams();
    const vault = await SecureVaultImpl.open({
      storage: new AsyncStorageVaultStorage(),
      keystore: seams.createKeyStore(),
      // Native Bouncy Castle KDF — noble argon2/scrypt is unusably slow
      // under Hermes (see kdf.ts in cemp-secure-vault).
      kdfEngine: seams.createKdfEngine(),
    });
    const container = new AppContainer(vault, seams);
    container.#setState(vault.state === "uninitialized" ? "uninitialized" : "locked");
    AppContainer.#current = container;
    return container;
  }

  get state(): AppContainerState {
    return this.#state;
  }

  /**
   * Whether the vault is usable RIGHT NOW, from the vault's own state and its
   * wall-clock inactivity deadline rather than from {@link state}.
   *
   * {@link state} is a UI-facing projection maintained by `#startPoll`, and
   * that poll is a JS timer: React Native freezes it while the app is
   * backgrounded, so the cached value can read `"ready"` minutes after the
   * vault auto-locked. Anything running on a woken runtime — the WorkManager
   * tick — must ask this instead.
   *
   * Synchronous and side-effect-free by construction: `vault.state` and
   * `vault.autoLockDeadlineMs` are plain getters. Note that `touch()` is NOT a
   * substitute — it RESTARTS the inactivity window, which would silently keep
   * a backgrounded vault unlocked forever, one tick at a time.
   */
  get vaultUsable(): boolean {
    return isVaultUsable({
      containerReady: this.#state === "ready",
      vaultUnlocked: this.vault.state === "unlocked",
      autoLockDeadlineMs: this.vault.autoLockDeadlineMs,
      nowMs: Date.now(),
    });
  }

  /**
   * Converge the cached projection with the vault's real state, for callers
   * that arrive after the poll has been suspended (the background tick).
   *
   * Without this the tick would branch correctly but leave the container still
   * claiming `"ready"` with the database open, until the resumed poll caught up
   * a second later — which is exactly the mid-flight teardown that made the
   * original failure a `DatabaseError` rather than a clean locked probe. Doing
   * it up front means the database is closed BEFORE any work starts.
   *
   * Locks the vault itself when the deadline passed while its own `setTimeout`
   * was frozen, so the overdue timer has nothing left to do when it fires.
   */
  async reconcileVaultState(): Promise<void> {
    if (this.#state !== "ready" || this.vaultUsable) {
      return;
    }
    if (this.vault.state === "unlocked") {
      await this.vault.lock();
    }
    await this.#handleExternalLock();
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
        scheduler: this.#seams.createScheduler(),
        createImageCodec: this.#seams.createImageCodec,
      });
    }
    this.#setState("ready");
    this.#startPoll();
    void this.#seams.requestNotificationPermission();
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
    // DESTROY, not close: the database is encrypted with a key derived from
    // the wallet seed, so it dies with the wallet. Merely closing it leaves a
    // file the next wallet cannot decrypt, and the app reported that as a
    // wrong password (device finding, 2026-07-29).
    await this.resetLocalData();
    // Stop the periodic tick BEFORE wiping: otherwise WorkManager keeps waking
    // a wiped identity and the locked probe keeps querying its route tags and
    // posting notifications for it. `cancelPeriodic()` is best-effort on its
    // own terms (WorkManagerScheduler swallows a missing native module or a
    // rejected native call, so its promise never rejects) — awaited here only
    // to sequence it ahead of the vault wipe below, never to gate it.
    await this.#seams.createScheduler().cancelPeriodic();
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

  /**
   * Observe the vault's auto-lock timer firing while the app is idle, and run
   * autonomous foreground chain sync.
   *
   * The two share this start/stop pair deliberately: both must be live exactly
   * while the vault is unlocked and the database open, and both are already
   * torn down at all four sites that call `#stopPoll` (lock, wipe, external
   * lock, and re-entry here). Giving foreground sync its own lifecycle would
   * be one more thing to keep in step — and a sync sweep that outlives the
   * database is precisely the crash `#closeDatabase` exists to avoid.
   */
  #startPoll(): void {
    this.#stopPoll();
    this.#poll = setInterval(() => {
      if (this.vault.state !== "unlocked") {
        void this.#handleExternalLock();
      }
    }, 1000);

    // Foreground sync only: WorkManager (`background-sync.ts`) owns the
    // backgrounded app and enforces its own floor, so the two must not run
    // sweeps on top of each other.
    const sync = new ForegroundSync({
      sync: async () => {
        if (this.#messaging === null) return;
        await this.#messaging.syncNow();
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      onError: () => {
        // Failures stay quiet: the workers retry with backoff (rule 5), and
        // the chats screen already surfaces sync status where the user can
        // act on it. Never log — a sync error can carry chain identifiers
        // (rule 2).
      },
    });
    this.#foregroundSync = sync;
    sync.start(IDLE_CADENCE_MS);
    this.#appStateSub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        sync.resume();
      } else {
        sync.pause();
      }
    });
  }

  #stopPoll(): void {
    if (this.#poll !== null) {
      clearInterval(this.#poll);
      this.#poll = null;
    }
    this.#foregroundSync?.stop();
    this.#foregroundSync = null;
    this.#appStateSub?.remove();
    this.#appStateSub = null;
  }

  /**
   * Tighten or relax the autonomous sync cadence — screens declare what they
   * need (a chat wants a reply promptly; a settings screen does not).
   * A no-op when the vault is locked, so a screen unmounting during teardown
   * cannot resurrect the scheduler.
   */
  setSyncCadence(cadenceMs: number): void {
    this.#foregroundSync?.setCadence(cadenceMs);
  }

  /**
   * Sweep now and resolve when it lands — for screen focus and pull-to-refresh.
   *
   * Goes through the scheduler so a user-initiated sweep cannot race a
   * scheduled one; when the vault is locked there is nothing to sync and this
   * resolves immediately rather than throwing at the caller.
   */
  async syncNow(): Promise<void> {
    await this.#foregroundSync?.runNow();
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
        name: DATABASE_NAME,
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
      localSettings: new LocalSettingsRepository(this.#db),
    };
  }

  /** Present the OS share sheet for a contact card PNG. */
  async shareContactCard(png: Uint8Array, caption: string): Promise<void> {
    await shareImage(png, caption);
  }

  /** Present the native camera scanner. Null on cancel. */
  async scanContactWithCamera(): Promise<string | null> {
    return await scanWithCamera();
  }

  /**
   * Let the user pick a photo and decode a QR from it. See
   * {@link ScanFromPhotoResult} for why "picker cancelled" and "no code in
   * the photo" are kept apart rather than both collapsing to `null`.
   */
  async scanContactFromPhoto(): Promise<ScanFromPhotoResult> {
    const bytes = await pickImage();
    if (bytes === null) {
      return { kind: "cancelled" };
    }
    const text = await scanImageForQr(bytes);
    if (text === null) {
      return { kind: "no-code" };
    }
    return { kind: "text", text };
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

  /**
   * Delete the local database FILE, keeping the wallet intact.
   *
   * Two callers: `wipe()` (the database belongs to the wallet being erased)
   * and the unlock screen's "Reset local data" escape, for a device already
   * holding a database from an earlier wallet — the state that made a
   * correct password look wrong (SQLCipher page-1 HMAC failure).
   *
   * Deliberately does NOT need the real database key. Deleting a file is not
   * reading it: op-sqlite hands back a handle whatever key it is given
   * (SQLCipher only fails at the first page read), so a throwaway key is
   * enough to obtain one and call `destroy()`. That matters because the most
   * important caller — "Forgot password? Reset wallet" on the LOCKED screen —
   * has no way to derive the real key, and a wipe that cannot delete the
   * database would strand the orphan this whole fix exists to prevent.
   */
  async resetLocalData(): Promise<void> {
    this.#messaging?.dispose();
    this.#messaging = null;
    this.#repositories = null;

    const open = this.#db;
    this.#db = null;
    if (open !== null) {
      await open.destroy();
      return;
    }
    // No live handle (locked vault, or a restart since the failed open): take
    // one purely as a means of deletion. If the file is absent this creates
    // and immediately removes an empty database — the intended end state.
    const throwaway = OpSqlCipherAdapter.open({
      name: DATABASE_NAME,
      encryptionKeyHex: "00".repeat(32),
    });
    await throwaway.destroy();
  }
}
