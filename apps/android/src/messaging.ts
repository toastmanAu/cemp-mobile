/**
 * Messaging service (P2P path): builds the chain-facing pieces on unlock and
 * owns identity info, profile publishing, text publication, and foreground
 * sync. Everything delegates to the proven pipelines (@cemp/ckb publisher,
 * lifecycle, sync engine) — this is the composition, not new protocol code.
 *
 * Testnet-only by construction (CKB_TESTNET, AGENTS.md rule 11).
 */

import {
  CempClient,
  MessagePublisher,
  MlDsaV2TxSigner,
  ResponseLifecycle,
  addressFromLockScript,
  buildCreateProfileTx,
  cccTransactionToWire,
  checkResolvedProfileBinding,
  trackBroadcastSpend,
  currentRoutingEpoch,
  fetchJsonRpcTransport,
  resolveLiveProfile,
  waitForTransactionCommit,
  type CempMessageTypeRef,
} from "@cemp/ckb";
import {
  CONSERVATIVE_MESSAGE_CELL_SHANNON,
  CONSERVATIVE_PER_CHUNK_SHANNON,
  SEND_FEE_RESERVE_SHANNONS,
  downloadAttachment,
  publishImageMessage,
  reclaimAttachmentGroup,
  type DownloadedAttachment,
  type ImageEncodeFormat,
} from "@cemp/images";
import {
  CKB_TESTNET,
  codec,
  deriveRouteTag,
  formatFingerprint,
  type ContactBundleV1,
} from "@cemp/core";
import {
  decryptEnvelope,
  deriveIdentityKeys,
  mldsaV2LockArgs,
  randomBytes,
  wipeIdentityKeyBundle,
  type IdentityKeyBundle,
} from "@cemp/crypto";
import { RateLimiter, DEFAULT_RATE_LIMITS } from "@cemp/ckb";
import { SyncEngine, BackoffPolicy, buildWorkerSpecs, type Scheduler } from "@cemp/sync";
import type { Notifier } from "@cemp/ui";
import type { SecureVaultImpl } from "@cemp/secure-vault";
import {
  AttachmentRepository,
  BalanceRepository,
  ContactRepository,
  ConversationRepository,
  DatabasePublicationStore,
  MessageRepository,
  OutgoingTransactionRepository,
  ProfileRepository,
  RateLimitRepository,
  SyncCursorRepository,
  WatchedOutpointRepository,
  WorkerLeaseRepository,
  migrate,
  type SqliteAdapter,
} from "@cemp/database";
import { ClientPublicTestnet, Script, bytesFrom, hexFrom } from "@ckb-ccc/core";
import { runImageSend } from "./image-send";
import { OutgoingTxJournalAdapter, AttachmentReclaimStoreAdapter } from "./outgoing-tx-journal";
import { bytesToHex, hexToBytes } from "./platform/hex";
// RN-free half of the image-codec seam only (Task 6's split): the concrete,
// react-native-backed `NativeImageCodec` must NEVER be imported here.
// messaging.test.ts constructs a real `MessagingService` under vitest, and
// react-native's own entrypoint uses Flow syntax vitest cannot parse — an
// import of it anywhere in this module's graph (even unused) crashes the
// whole test file before a single test runs. The composition root
// (app-container.ts, which already pulls in every other RN platform seam and
// is never loaded under vitest) injects the real codec factory instead.
import { HandleTracker, type ReleasableImageCodec } from "./platform/handle-tracker";

const textEncoder = new TextEncoder();

export interface MessagingIdentity {
  readonly address: string;
  readonly lockArgs: string;
  readonly lockScriptHash: string;
}

export class MessagingService {
  readonly #signer: MlDsaV2TxSigner;
  readonly #client: CempClient;
  readonly #publisher: MessagePublisher;
  readonly #engine: SyncEngine;
  readonly #profiles: ProfileRepository;
  readonly #outgoingTxs: OutgoingTransactionRepository;
  readonly #attachments: AttachmentRepository;
  readonly #messages: MessageRepository;
  readonly #bundle: IdentityKeyBundle;
  readonly #accountId: number;
  readonly #balances: BalanceRepository;
  readonly #walletId: number;
  readonly #messageType: CempMessageTypeRef;
  readonly #senderProfileId: Uint8Array;
  readonly #senderDeviceId: Uint8Array;
  readonly #createImageCodec: (() => ReleasableImageCodec) | undefined;

  private constructor(deps: {
    signer: MlDsaV2TxSigner;
    client: CempClient;
    publisher: MessagePublisher;
    engine: SyncEngine;
    profiles: ProfileRepository;
    outgoingTxs: OutgoingTransactionRepository;
    attachments: AttachmentRepository;
    messages: MessageRepository;
    bundle: IdentityKeyBundle;
    accountId: number;
    balances: BalanceRepository;
    walletId: number;
    messageType: CempMessageTypeRef;
    senderProfileId: Uint8Array;
    senderDeviceId: Uint8Array;
    createImageCodec: (() => ReleasableImageCodec) | undefined;
  }) {
    this.#signer = deps.signer;
    this.#client = deps.client;
    this.#publisher = deps.publisher;
    this.#engine = deps.engine;
    this.#profiles = deps.profiles;
    this.#outgoingTxs = deps.outgoingTxs;
    this.#attachments = deps.attachments;
    this.#messages = deps.messages;
    this.#bundle = deps.bundle;
    this.#accountId = deps.accountId;
    this.#balances = deps.balances;
    this.#walletId = deps.walletId;
    this.#messageType = deps.messageType;
    this.#senderProfileId = deps.senderProfileId;
    this.#senderDeviceId = deps.senderDeviceId;
    this.#createImageCodec = deps.createImageCodec;
  }

  /** Build the service from the unlocked vault + opened DB. */
  static async init(deps: {
    vault: SecureVaultImpl;
    db: SqliteAdapter;
    notifier: Notifier;
    scheduler: Scheduler;
    /**
     * Factory for the platform image codec (Task 13). Injected — not
     * imported here — so this module stays react-native-free (see the
     * import comment above); the composition root supplies
     * `() => new NativeImageCodec()`. Omitted in contexts that never send
     * images (e.g. messaging.test.ts's background-scheduling regression
     * guard): `publishImage` throws a clear error if called without one.
     */
    createImageCodec?: () => ReleasableImageCodec;
  }): Promise<MessagingService> {
    const { vault, db, notifier, scheduler } = deps;
    const bundle = await vault.withUnlockedSeed((seed) => deriveIdentityKeys(seed));
    const mlDsaDeployment = CKB_TESTNET.deployments.mlDsaLock;
    const cempType = CKB_TESTNET.deployments.cempMessageType;
    if (mlDsaDeployment === null || cempType === null) {
      throw new Error("testnet deployments are not pinned in the network config");
    }

    await migrate(db);
    const balances = new BalanceRepository(db);
    const walletId = await balances.ensureWallet("main");
    const accountId = await ensureAccount(db, walletId);

    const lock = Script.from({
      codeHash: mlDsaDeployment.codeHash,
      hashType: mlDsaDeployment.hashType,
      args: hexFrom(mldsaV2LockArgs(bundle.mlDsa.publicKey)),
    });
    const cccClient = new ClientPublicTestnet({ url: CKB_TESTNET.endpoints[0]!.rpc });
    const signer = new MlDsaV2TxSigner({
      keyPair: { publicKey: bundle.mlDsa.publicKey, secretKey: bundle.mlDsa.secretKey },
      client: cccClient,
    });
    const client = new CempClient({
      transport: fetchJsonRpcTransport(15_000),
      endpoints: CKB_TESTNET.endpoints[0]!,
    });
    const messageType: CempMessageTypeRef = {
      codeHash: cempType.codeHash,
      hashType: cempType.hashType,
      cellDep: { txHash: cempType.txHash, index: "0x0", depType: "code" },
    };

    const contacts = new ContactRepository(db);
    const conversations = new ConversationRepository(db);
    const messages = new MessageRepository(db);
    const outgoingTxs = new OutgoingTransactionRepository(db);
    const attachments = new AttachmentRepository(db);
    const watchedOutpoints = new WatchedOutpointRepository(db);
    const store = new DatabasePublicationStore(messages, outgoingTxs, {
      watchedOutpoints,
      balances,
      walletId,
    });

    const profiles = new ProfileRepository(db);
    const active = await profiles.getActiveByAccount(accountId);
    const senderProfileId =
      active === undefined ? new Uint8Array(32) : bytesFrom(`0x${active.profileIdHex}`);

    const deviceId = randomBytes(16);
    const publisher = new MessagePublisher({
      client,
      signer,
      messageType,
      store,
      senderProfileId,
      senderDeviceId: deviceId,
    });
    const lifecycle = new ResponseLifecycle({ client, signer, messageType, store });
    const cursors = new SyncCursorRepository(db);
    const leases = new WorkerLeaseRepository(db);
    const engineId = `engine-${bytesToHex(randomBytes(8))}`;
    const engine = new SyncEngine({
      scheduler,
      leases,
      cursors,
      workers: buildWorkerSpecs({
        client,
        messageType,
        lifecycle,
        publisher,
        messages,
        contacts,
        conversations,
        outgoingTxs,
        attachments,
        cursors,
        leases,
        balances,
        rateLimiter: new RateLimiter(new RateLimitRepository(db), { ...DEFAULT_RATE_LIMITS }),
        walletId,
        walletLock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args },
        notifier,
        engineId,
        ownProfileId: senderProfileId,
        ownKemSecretKey: bundle.mlKem.secretKey,
        // T17 finding F-2: the batch reclaim only spends message cells — this
        // injected closure reclaims each group's chunk cells (spec §9.5).
        reclaimAttachmentGroup: ({ reclaimGroupId, outpoints }) =>
          reclaimAttachmentGroup(
            {
              client,
              signer,
              messageType,
              store: new AttachmentReclaimStoreAdapter(outgoingTxs, balances, walletId),
            },
            reclaimGroupId,
            outpoints,
          ),
      }),
      backoff: new BackoffPolicy({ jitter: 0 }),
      engineId,
    });
    // Register every worker with the scheduler (Phase 9 exit criterion: a
    // WorkManager job must be enqueued once the app is unlocked). `start()`
    // is deliberately called here, inside composition, rather than left for
    // a caller to remember: `init()` runs exactly once per unlock (see
    // AppContainer#afterVaultUnlock's `#messaging === null` guard), so this
    // fires on every unlock, matching `start()`'s documented idempotent
    // re-registration contract. Folding it into construction — instead of a
    // separate public `start()` step on MessagingService — is what closes
    // the gap that shipped Phase 9 without it: an engine that is
    // constructed-but-not-started can no longer exist as a distinct state.
    engine.start();

    return new MessagingService({
      signer,
      client,
      publisher,
      engine,
      profiles,
      outgoingTxs,
      attachments,
      messages,
      bundle,
      accountId,
      balances,
      walletId,
      messageType,
      senderProfileId,
      senderDeviceId: deviceId,
      createImageCodec: deps.createImageCodec,
    });
  }

  /** Address + lock info for the wallet tab and funding instructions. */
  identity(): MessagingIdentity {
    const lock = this.#signer.lockScript();
    return {
      address: addressFromLockScript(lock, this.#signer.client),
      lockArgs: lock.args,
      lockScriptHash: lock.hash(),
    };
  }

  /** The on-chain profile id of this device, once published. */
  async myProfileId(): Promise<string | null> {
    const active = await this.#profiles.getActiveByAccount(this.#accountId);
    return active === undefined ? null : active.profileIdHex;
  }

  /** Display-form identity fingerprint (spec §10.3), once a profile exists. */
  async myFingerprint(): Promise<string | null> {
    const profileIdHex = await this.myProfileId();
    if (profileIdHex === null) return null;
    return formatFingerprint({
      profileId: bytesFrom(`0x${profileIdHex}`),
      mlDsaPublicKey: this.#bundle.mlDsa.publicKey,
      mlKemPublicKey: this.#bundle.mlKem.publicKey,
    });
  }

  /**
   * This device's contact bundle (spec §5.4) — the QR payload for contact
   * exchange. Null until a profile is published: three of the five fields
   * come from the on-chain profile cell, so no card can exist before it.
   */
  async myContactBundle(): Promise<ContactBundleV1 | null> {
    const profileIdHex = await this.myProfileId();
    if (profileIdHex === null) {
      return null;
    }
    const fingerprint = await this.myFingerprint();
    if (fingerprint === null) {
      return null;
    }
    const id = this.identity();
    return {
      profileTypeId: `0x${profileIdHex}`,
      lockScriptHash: id.lockScriptHash,
      address: id.address,
      fingerprint,
      // Rule 11: never construct a bundle for a network this build is not on.
      network: CKB_TESTNET.name,
    };
  }

  /** Publish this device's profile cell (requires a funded wallet). */
  async publishMyProfile(handle: string): Promise<{ profileId: string; txHash: string }> {
    const existing = await this.myProfileId();
    if (existing !== null) {
      return { profileId: existing, txHash: "(already published)" };
    }
    const profile = {
      protocol_version: 1,
      sig_algorithm: { family: 0x01, parameter: 61 },
      kem_algorithm: { family: 0x02, parameter: 3 },
      ml_dsa_public_key: this.#bundle.mlDsa.publicKey,
      ml_kem_public_key: this.#bundle.mlKem.publicKey,
      lock_script_hash: bytesFrom(this.#signer.lockScript().hash()),
      supported_protocol_versions: [1],
      supported_attachments: 0,
      handle: textEncoder.encode(handle),
      icon_hash: undefined,
      key_created_at: BigInt(Math.floor(Date.now() / 1000)),
      rotation_sequence: 0,
      previous_profile_id: undefined,
      revoked: 0,
    };
    const built = await buildCreateProfileTx({ profile, signer: this.#signer });
    const typeArgs = built.tx.outputs[0]!.type!.args;
    const signed = await this.#signer.signTransaction(built.tx);
    const txHash = signed.hash();
    const wire = cccTransactionToWire(signed);
    // Rule 6: journal BEFORE broadcast (signed bytes for resume).
    await this.#outgoingTxs.record({
      txHash,
      purpose: "profile:create",
      state: "submitted",
      feeShannon: built.estimatedFee.toString(),
      txHex: JSON.stringify(wire),
      submittedAtMs: Date.now(),
    });
    const accepted = await this.#client.sendTransaction(wire);
    if (accepted !== txHash) {
      throw new Error("publishMyProfile: node returned a different tx hash");
    }
    // Record the spend so the first message send does not re-select the cells
    // this profile transaction just consumed (they stay "live" on the indexer
    // until it commits).
    await trackBroadcastSpend(this.#signer, signed);
    await waitForTransactionCommit(this.#client, txHash, {});
    await this.#outgoingTxs.markState(txHash, "committed", { committedAtMs: Date.now() });
    await this.#profiles.create({
      accountId: this.#accountId,
      profileIdHex: typeArgs.slice(2),
      typeIdHex: typeArgs,
      outpointTxHash: txHash,
      outpointIndex: 0,
      state: "active",
    });
    return { profileId: typeArgs.slice(2), txHash };
  }

  /**
   * Publish one queued message to a contact (Phase 7 path end-to-end). The
   * message row already exists (composer inserted it as draft/queued).
   */
  async publishMessage(input: {
    messageRowId: number;
    logicalMessageId: string;
    text: string;
    recipientProfileIdHex: string;
  }): Promise<{ txHash: string }> {
    const result = await this.#publisher.publishText({
      messageRowId: input.messageRowId,
      logicalMessageId: input.logicalMessageId,
      text: input.text,
      recipientProfileIdHex: input.recipientProfileIdHex,
      receiptRequest: 1,
    });
    return { txHash: result.txHash };
  }

  /**
   * Publish one queued image message (spec §4 decision 5A, Task 13; Task 15a
   * moved recipient resolution in-band so callers only ever supply a profile
   * id, matching `publishMessage`'s shape). Resolves the recipient's live
   * profile the same way the text publish path does (rule 4: re-resolve +
   * binding-check on every send) to derive the KEM public key and raw
   * profile id, then hands off to `runImageSend`, which owns the capacity
   * pre-flight and the `ImageTooLargeError` → jargon-free mapping. The image
   * is prepared exactly once (inside `runImageSend`, through the tracker) and
   * the result is threaded into `publishImageMessage` — one `releaseAll()`
   * here covers every native handle that single prepare created.
   */
  async publishImage(input: {
    messageRowId: number;
    logicalMessageId: string;
    recipientProfileIdHex: string;
    sourceBytes: Uint8Array;
    caption?: string;
    format?: ImageEncodeFormat;
    timeoutMs?: number;
  }): Promise<{ messageTxHash: string }> {
    // Desync guard (final review): a UI retry after the message tx was already
    // journaled/broadcast (e.g. commit timeout on attempt 1) must NOT re-run
    // the chunk pipeline — that would re-upload every chunk cell under a NEW
    // encryption key while the on-chain manifest still names the attempt-1
    // chunks, orphaning the new ones. When a `message:<logicalMessageId>`
    // record is already in flight, skip the chunk work entirely and let
    // `publishText`'s resume path drive the journaled tx to commit instead.
    // The attachments row is deliberately left untouched here: the attempt-1
    // manifest is the truth.
    const journaled = await this.#outgoingTxs.findLatestByPurpose(
      `message:${input.logicalMessageId}`,
    );
    if (
      journaled !== undefined &&
      (journaled.state === "submitted" || journaled.state === "committed")
    ) {
      const resumed = await this.#publisher.publishText({
        messageRowId: input.messageRowId,
        logicalMessageId: input.logicalMessageId,
        text: input.caption ?? "",
        recipientProfileIdHex: input.recipientProfileIdHex,
        receiptRequest: 1,
      });
      return { messageTxHash: resumed.txHash };
    }
    if (this.#createImageCodec === undefined) {
      throw new Error("publishImage: no image codec configured for this platform");
    }
    const tracker = new HandleTracker(this.#createImageCodec());
    try {
      const resolved = await resolveLiveProfile(this.#client, input.recipientProfileIdHex);
      checkResolvedProfileBinding(resolved, input.recipientProfileIdHex);
      const recipientProfileId = hexToBytes(input.recipientProfileIdHex);
      const journal = new OutgoingTxJournalAdapter(
        this.#outgoingTxs,
        this.#balances,
        this.#walletId,
      );
      const balance = await this.#balances.getBalance(this.#walletId);
      const result = await runImageSend(
        {
          codec: tracker,
          availableShannon: balance.availableShannon,
          perChunkShannon: CONSERVATIVE_PER_CHUNK_SHANNON,
          messageCellShannon: CONSERVATIVE_MESSAGE_CELL_SHANNON,
          feeReserveShannon: SEND_FEE_RESERVE_SHANNONS,
          publish: (manifestInput) =>
            publishImageMessage(
              {
                codec: tracker,
                client: this.#client,
                signer: this.#signer,
                messageType: this.#messageType,
                journal,
                publisher: this.#publisher,
                senderProfileId: this.#senderProfileId,
                senderDeviceId: this.#senderDeviceId,
                randomBytes,
              },
              manifestInput,
            ),
          attachments: this.#attachments,
        },
        {
          messageRowId: input.messageRowId,
          logicalMessageId: input.logicalMessageId,
          recipientProfileIdHex: input.recipientProfileIdHex,
          recipientKemPublicKey: resolved.profile.ml_kem_public_key,
          recipientProfileId,
          sourceBytes: input.sourceBytes,
          ...(input.caption === undefined ? {} : { caption: input.caption }),
          ...(input.format === undefined ? {} : { format: input.format }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        },
      );
      return { messageTxHash: result.messageTxHash };
    } finally {
      await tracker.releaseAll();
    }
  }

  /**
   * Resolve the attachment key for one already-received image message (Task
   * 15a; spec §9.2/§9.4). Amended key discipline (2026-07-26): the key is
   * persisted in the ENCRYPTED application database at discovery (rule 3) —
   * the original "never stored" decision predates the discovery that chain
   * re-derivation depends on the message cell, which the sender can reclaim
   * after ack (rule 9), permanently bricking tap-to-download even though the
   * history row survives (rule 8). The stored key is preferred; re-deriving
   * from the live message cell remains the fallback for pre-v8 rows. The key
   * is a decrypt-time secret either way — a caller must wipe it after
   * `downloadAttachment` finishes with it.
   */
  async deriveIncomingAttachmentKey(messageId: number): Promise<Uint8Array> {
    const stored = (await this.#attachments.listForMessage(messageId)).find(
      (a) => a.attachmentKey !== null,
    );
    if (stored?.attachmentKey != null) {
      // Return a COPY: downloadImageAttachment wipes the returned buffer in
      // `finally`, and that wipe must not zero the repository row's bytes.
      return stored.attachmentKey.slice();
    }
    // Legacy fallback (pre-v8 rows, or a row stored before the key column
    // existed): re-derive from the message cell — requires it to still be
    // live on-chain, which a sender-side reclaim may have ended.
    const ref = await this.#messages.getChainRef(messageId);
    if (ref === undefined || ref.txHash === null || ref.outpointIndex === null) {
      throw new Error(
        `deriveIncomingAttachmentKey: message ${String(messageId)} has no recorded chain reference`,
      );
    }
    const status = await this.#client.getLiveCell({
      txHash: ref.txHash,
      index: `0x${ref.outpointIndex.toString(16)}`,
    });
    if (status.status !== "live") {
      throw new Error(
        `deriveIncomingAttachmentKey: message ${String(messageId)}'s cell is not live (${status.status})`,
      );
    }
    const decrypted = decryptEnvelope({
      envelopeBytes: hexToBytes(status.cell.data),
      recipientKemSecretKey: this.#bundle.mlKem.secretKey,
      ownProfileId: this.#senderProfileId,
    });
    try {
      return decrypted.attachmentKey;
    } finally {
      // Only the key leaves this scope; the decrypted payload copy is wiped.
      decrypted.payloadBytes.fill(0);
    }
  }

  /**
   * Download + decrypt one incoming image attachment (Task 15b; spec §9.4
   * tap-to-download). Centralizes the two secrets the screen must never
   * touch directly: the `CempClient` used to fetch chunk cells, and the
   * per-message attachment key (from the encrypted database, falling back to
   * the stored envelope for legacy rows). The key is wiped as soon as
   * `downloadAttachment` returns, success or failure.
   */
  async downloadImageAttachment(
    messageId: number,
    manifest: codec.AttachmentManifestV1,
  ): Promise<DownloadedAttachment> {
    const key = await this.deriveIncomingAttachmentKey(messageId);
    try {
      return await downloadAttachment(this.#client, manifest, key);
    } finally {
      key.fill(0);
    }
  }

  /** Wallet balances for the wallet tab (spec §5.5 categories). */
  async balances() {
    return await this.#balances.getBalance(this.#walletId);
  }

  /** Foreground sync: discovery + pending txs + watches + reclaim. */
  async syncNow(): Promise<Record<string, string>> {
    return await this.#engine.runAllNow();
  }

  /**
   * Hex route tags for the previous, current and next epoch. Caching the NEXT
   * epoch's tag is what keeps the locked probe working across a rollover
   * (Phase 9 design D2).
   */
  async routeTagsHex(): Promise<string[]> {
    const profileIdHex = await this.myProfileId();
    if (profileIdHex === null) {
      return [];
    }
    const profileId = bytesFrom(`0x${profileIdHex}`);
    const epoch = currentRoutingEpoch(Date.now());
    return [epoch - 1n, epoch, epoch + 1n].map((e) => bytesToHex(deriveRouteTag(profileId, e)));
  }

  /** Wipe in-memory secret key material (called on lock/wipe). */
  dispose(): void {
    wipeIdentityKeyBundle(this.#bundle);
  }
}

/** The single account row for this device (idempotent). */
async function ensureAccount(db: SqliteAdapter, walletId: number): Promise<number> {
  const existing = await db.get("SELECT id FROM accounts WHERE wallet_id = ? ORDER BY id LIMIT 1", [
    walletId,
  ]);
  if (existing !== undefined) {
    return Number(existing.id);
  }
  const result = await db.run(
    "INSERT INTO accounts (wallet_id, label, network, created_at_ms) VALUES (?, ?, ?, ?)",
    [walletId, "main", "ckb_testnet", Date.now()],
  );
  return result.lastInsertRowid;
}
