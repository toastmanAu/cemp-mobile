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
  fetchJsonRpcTransport,
  waitForTransactionCommit,
  type CempMessageTypeRef,
} from "@cemp/ckb";
import { CKB_TESTNET, formatFingerprint } from "@cemp/core";
import {
  deriveIdentityKeys,
  mldsaV2LockArgs,
  randomBytes,
  wipeIdentityKeyBundle,
  type IdentityKeyBundle,
} from "@cemp/crypto";
import { RateLimiter, DEFAULT_RATE_LIMITS } from "@cemp/ckb";
import { SyncEngine, BackoffPolicy, InMemoryScheduler, buildWorkerSpecs } from "@cemp/sync";
import type { Notifier } from "@cemp/ui";
import type { SecureVaultImpl } from "@cemp/secure-vault";
import {
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

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  readonly #bundle: IdentityKeyBundle;
  readonly #accountId: number;
  readonly #balances: BalanceRepository;
  readonly #walletId: number;

  private constructor(deps: {
    signer: MlDsaV2TxSigner;
    client: CempClient;
    publisher: MessagePublisher;
    engine: SyncEngine;
    profiles: ProfileRepository;
    outgoingTxs: OutgoingTransactionRepository;
    bundle: IdentityKeyBundle;
    accountId: number;
    balances: BalanceRepository;
    walletId: number;
  }) {
    this.#signer = deps.signer;
    this.#client = deps.client;
    this.#publisher = deps.publisher;
    this.#engine = deps.engine;
    this.#profiles = deps.profiles;
    this.#outgoingTxs = deps.outgoingTxs;
    this.#bundle = deps.bundle;
    this.#accountId = deps.accountId;
    this.#balances = deps.balances;
    this.#walletId = deps.walletId;
  }

  /** Build the service from the unlocked vault + opened DB. */
  static async init(deps: {
    vault: SecureVaultImpl;
    db: SqliteAdapter;
    notifier: Notifier;
  }): Promise<MessagingService> {
    const { vault, db, notifier } = deps;
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
      scheduler: new InMemoryScheduler(),
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
      }),
      backoff: new BackoffPolicy({ jitter: 0 }),
      engineId,
    });

    return new MessagingService({
      signer,
      client,
      publisher,
      engine,
      profiles,
      outgoingTxs,
      bundle,
      accountId,
      balances,
      walletId,
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

  /** Wallet balances for the wallet tab (spec §5.5 categories). */
  async balances() {
    return await this.#balances.getBalance(this.#walletId);
  }

  /** Foreground sync: discovery + pending txs + watches + reclaim. */
  async syncNow(): Promise<Record<string, string>> {
    return await this.#engine.runAllNow();
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
