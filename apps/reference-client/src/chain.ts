import { Script as CccScriptClass, bytesFrom } from "@ckb-ccc/core";
import type { Script as CccScript } from "@ckb-ccc/core";
import { CKB_TESTNET, codec } from "@cemp/core";
import { randomBytes } from "@cemp/crypto";
import type { IdentityKeyBundle } from "@cemp/crypto";
import {
  CempClient,
  MlDsaV2TxSigner,
  TYPE_ID_CODE_HASH,
  clientCellResolver,
  collectCells,
} from "@cemp/ckb";
import type { BuiltTransaction, Cell, CempMessageTypeRef, Hash } from "@cemp/ckb";
import { IDENTITY_HANDLES, IDENTITY_NAMES, deriveIdentity } from "./identities.js";
import type { IdentityName } from "./identities.js";
import { StateStore, defaultIdentityState, defaultSharedState } from "./state.js";
import type { DeploymentRecord, IdentityState, SharedState } from "./state.js";
import { journalEntryFromBuilt, writeJournal } from "./journal.js";
import { cccTxToWire } from "./wire.js";

/**
 * Chain-facing context and helpers shared by all steps: client/signer
 * construction, balance snapshots, commit waiting, profile resolution,
 * envelope assembly and the journal → sign → broadcast → commit pipeline.
 */

/** A step failure carrying the process exit code (2 = funding gate). */
export class StepFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "StepFailure";
    this.exitCode = exitCode;
  }
}

export interface RuntimeIdentity {
  name: IdentityName;
  handle: string;
  bundle: IdentityKeyBundle;
  signer: MlDsaV2TxSigner;
  lock: CccScript;
  address: string;
  lockArgs: string;
  lockScriptHash: string;
  state: IdentityState;
}

export interface Ctx {
  store: StateStore;
  client: CempClient;
  shared: SharedState;
  identities: Record<IdentityName, RuntimeIdentity>;
  /** Save shared.json + both identity files. */
  save(): void;
  saveIdentity(name: IdentityName): void;
}

function hexOf(bytes: Uint8Array): string {
  return codec.bytesToHex(bytes);
}

/** Build the runtime context: client, signers and state files (created on first run). */
export async function loadCtx(stateDir: string): Promise<Ctx> {
  const store = new StateStore(stateDir);
  store.ensureDirs();
  const client = new CempClient({ network: CKB_TESTNET });

  const shared = store.sharedExists() ? store.loadShared() : defaultSharedState();

  const identities = {} as Record<IdentityName, RuntimeIdentity>;
  for (const name of IDENTITY_NAMES) {
    const bundle = deriveIdentity(name);
    const signer = MlDsaV2TxSigner.fromIdentityKeys(bundle, client.ccc, CKB_TESTNET);
    const lock = signer.lockScript();
    const addressObjs = await signer.getAddressObjs();
    const address = addressObjs[0]?.toString();
    if (address === undefined) {
      throw new StepFailure(`could not derive an address for ${name}`);
    }
    const derived = {
      handle: IDENTITY_HANDLES[name],
      address,
      lockArgs: lock.args,
      lockScriptHash: lock.hash(),
      // Persisted across runs (spec §2: per installation); generated once.
      deviceId: hexOf(randomBytes(16)),
    };
    let state: IdentityState;
    if (store.identityExists(name)) {
      state = store.loadIdentity(name);
      // Derived fields are deterministic; refresh them defensively.
      state.handle = derived.handle;
      state.address = derived.address;
      state.lockArgs = derived.lockArgs;
      state.lockScriptHash = derived.lockScriptHash;
    } else {
      state = defaultIdentityState(name, derived);
    }
    identities[name] = {
      name,
      handle: derived.handle,
      bundle,
      signer,
      lock,
      address,
      lockArgs: derived.lockArgs,
      lockScriptHash: derived.lockScriptHash,
      state,
    };
  }

  const ctx: Ctx = {
    store,
    client,
    shared,
    identities,
    save() {
      store.saveShared(shared);
      store.saveIdentity(identities.alice.state);
      store.saveIdentity(identities.bob.state);
    },
    saveIdentity(name) {
      store.saveIdentity(identities[name].state);
    },
  };
  ctx.save();
  return ctx;
}

// ── balances ────────────────────────────────────────────────────────────────

export interface BalanceSnapshotBig {
  total: bigint;
  spendable: bigint;
  cellCount: number;
}

/**
 * Balance snapshot over ALL live cells of the lock. `spendable` follows the
 * usual wallet definition (CCC's own `getBalanceSingle` applies the same
 * filter): cells with no type script and empty data. Protocol cells (profile,
 * message, contract) keep their owner's lock but are not spendable.
 */
export async function balanceSnapshot(
  client: CempClient,
  lock: CccScript,
): Promise<BalanceSnapshotBig> {
  const cells = await collectCells(client, {
    codeHash: lock.codeHash,
    hashType: lock.hashType,
    args: lock.args,
  });
  let total = 0n;
  let spendable = 0n;
  for (const cell of cells) {
    const capacity = BigInt(cell.output.capacity);
    total += capacity;
    if (cell.output.type === null && cell.data === "0x") {
      spendable += capacity;
    }
  }
  return { total, spendable, cellCount: cells.length };
}

/** Whole-CKB + 8-decimal rendering of a shannon amount. */
export function formatCkb(shannons: bigint): string {
  const sign = shannons < 0n ? "-" : "";
  const abs = shannons < 0n ? -shannons : shannons;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, "0");
  return `${sign}${whole}.${frac}`;
}

// ── commit waiting ──────────────────────────────────────────────────────────

const COMMIT_TIMEOUT_MS = 180_000; // ~3 min, per milestone brief
const COMMIT_POLL_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `get_transaction` until committed (rule 7: commitment of THIS tx only). */
export async function waitForCommit(
  client: CempClient,
  txHash: Hash,
  log: (m: string) => void,
): Promise<void> {
  const deadline = Date.now() + COMMIT_TIMEOUT_MS;
  for (;;) {
    const status = await client.getTransaction(txHash);
    if (status.status === "committed") {
      log(`committed in block ${BigInt(status.blockNumber)} (${txHash})`);
      return;
    }
    if (status.status === "rejected") {
      throw new StepFailure(
        `transaction ${txHash} was rejected${status.reason === undefined ? "" : `: ${status.reason}`}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new StepFailure(
        `timed out after ${COMMIT_TIMEOUT_MS / 1000}s waiting for ${txHash} to commit ` +
          `(last status: ${status.status}) — re-run the step to keep waiting`,
      );
    }
    log(`… ${txHash.slice(0, 18)}… status=${status.status}, waiting`);
    await sleep(Math.min(COMMIT_POLL_MS, remaining));
  }
}

// ── deployment / type script references ─────────────────────────────────────

/** The CEMP message type script ref: run-state deployment first, network config second. */
export function cempMessageTypeRef(ctx: Ctx): CempMessageTypeRef {
  const deployed = ctx.shared.deployment;
  if (deployed !== null) {
    return messageTypeRefFromDeployment(deployed);
  }
  const fromConfig = CKB_TESTNET.deployments.cempMessageType;
  if (fromConfig !== null) {
    return {
      codeHash: fromConfig.codeHash,
      hashType: fromConfig.hashType,
      cellDep: {
        txHash: fromConfig.txHash,
        index: `0x${fromConfig.index.toString(16)}`,
        depType: fromConfig.depType,
      },
    };
  }
  throw new StepFailure(
    "cemp-message-type is not deployed on this network — run the deploy-type step first",
  );
}

export function messageTypeRefFromDeployment(record: DeploymentRecord): CempMessageTypeRef {
  return {
    codeHash: record.codeHash,
    hashType: record.hashType,
    cellDep: {
      txHash: record.deployTxHash,
      index: `0x${record.outPointIndex.toString(16)}`,
      depType: "code",
    },
  };
}

// ── profile resolution ──────────────────────────────────────────────────────

export interface ResolvedProfile {
  cell: Cell;
  profile: codec.CempProfileV1;
}

/**
 * Resolve a live profile cell by its Type ID (spec §5.5) and validate it
 * through the codec pipeline (rule 4: indexer output is hostile). Throws
 * unless exactly one well-formed live cell exists.
 */
export async function resolveLiveProfile(
  client: CempClient,
  profileIdHex: string,
): Promise<ResolvedProfile> {
  const page = await client.findCells({
    script: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: `0x${profileIdHex}` },
    scriptType: "type",
    argsSearchMode: "exact",
    limit: 8,
  });
  if (page.cells.length === 0) {
    throw new StepFailure(`no live profile cell for profile id ${profileIdHex}`);
  }
  if (page.cells.length > 1) {
    throw new StepFailure(
      `impossible: ${page.cells.length} live cells share profile id ${profileIdHex} (Type ID uniqueness)`,
    );
  }
  const cell = page.cells[0]!;
  const data = bytesFrom(cell.data);
  const validation = codec.validateProfile(data);
  if (!validation.ok) {
    throw new StepFailure(`on-chain profile cell failed validation: ${validation.reason}`);
  }
  return { cell, profile: codec.decodeCempProfileV1(data) };
}

/**
 * Fingerprint checks on a resolved profile against what we recorded at
 * creation time (rule 4): type args, KEM key and lock-script-hash binding.
 */
export function checkProfileFingerprint(
  resolved: ResolvedProfile,
  expected: { profileId: string; kemPublicKey: string },
): void {
  const typeArgs = resolved.cell.output.type?.args;
  if (typeArgs !== `0x${expected.profileId}`) {
    throw new StepFailure(
      `profile cell type args ${typeArgs ?? "none"} != recorded profile id ${expected.profileId}`,
    );
  }
  if (codec.bytesToHex(resolved.profile.ml_kem_public_key) !== expected.kemPublicKey) {
    throw new StepFailure("on-chain profile KEM key does not match the recorded fingerprint");
  }
  const cellLockHash = CccScriptClass.from({
    codeHash: resolved.cell.output.lock.codeHash,
    hashType: resolved.cell.output.lock.hashType,
    args: resolved.cell.output.lock.args,
  }).hash();
  if (codec.bytesToHex(resolved.profile.lock_script_hash) !== strip0x(cellLockHash)) {
    throw new StepFailure("on-chain profile lock_script_hash does not match its cell lock");
  }
}

/** Message assembly lives in @cemp/ckb (Phase 7) — re-exported for the steps. */
export { assembleTextMessage, currentRoutingEpoch, ROUTING_EPOCH_SECONDS } from "@cemp/ckb";
export type { AssembleTextMessageParams, AssembledMessage } from "@cemp/ckb";

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

// ── journal → sign → broadcast → commit pipeline ────────────────────────────

export interface BuildPlan<P extends Record<string, unknown>> {
  built: BuiltTransaction;
  signer: MlDsaV2TxSigner;
  /** Journal metadata (no plaintext content). */
  metadata: Record<string, unknown>;
  /** Data the finalize callback needs after commit; persisted as pending record. */
  pendingData: P;
}

/**
 * The full broadcast lifecycle for one transaction, idempotent across
 * restarts (rules 5, 6):
 *
 *  1. skip when `label` is already checkpointed;
 *  2. when a pending broadcast exists (crash between send and commit), wait
 *     for THAT hash instead of rebuilding (no double broadcast);
 *  3. otherwise: journal the unsigned tx (rule 6) → sign → self-verify →
 *     `send_transaction` → persist the pending record → wait for commit →
 *     `finalize` → checkpoint.
 */
export async function broadcastAndCheckpoint<P extends Record<string, unknown>>(
  ctx: Ctx,
  label: string,
  log: (m: string) => void,
  build: () => Promise<BuildPlan<P>>,
  finalize: (committed: P & { txHash: string }) => Promise<void> | void,
): Promise<{ txHash: string; skipped: boolean }> {
  if (ctx.shared.steps[label] === true) {
    return { txHash: "", skipped: true };
  }

  const existing = ctx.shared.pending[label] as (P & { txHash: string }) | undefined;
  let committed: P & { txHash: string };
  if (existing !== undefined) {
    log(`resuming: broadcast ${existing.txHash} is already pending — waiting for its commit`);
    committed = existing;
  } else {
    const plan = await build();
    const wireUnsigned = cccTxToWire(plan.built.tx);
    // Rule 6: journal BEFORE signing/broadcast.
    const journalPath = writeJournal(
      ctx.store.journalDir,
      journalEntryFromBuilt(
        label,
        ctx.client.network.name,
        plan.built,
        wireUnsigned,
        plan.metadata,
      ),
    );
    log(`journaled unsigned tx → ${journalPath}`);

    const signed = await plan.signer.signTransaction(plan.built.tx);
    // Pre-broadcast self-check: re-verify our own signature off-chain.
    const resolver = clientCellResolver(ctx.client.ccc);
    const resolved = [];
    for (const input of signed.inputs) {
      const cell = await resolver.resolve(input.previousOutput);
      if (cell === undefined) {
        throw new StepFailure(
          `input ${input.previousOutput.txHash}:${input.previousOutput.index} is not live at signing time`,
        );
      }
      resolved.push(cell);
    }
    if (!plan.signer.verifyOwnSignature(signed, resolved)) {
      throw new StepFailure(
        "self-verification of the signed transaction failed — not broadcasting",
      );
    }

    const txHash = await ctx.client.sendTransaction(cccTxToWire(signed));
    const localHash = signed.hash();
    if (txHash !== localHash) {
      throw new StepFailure(
        `node accepted the tx but returned ${txHash}, locally computed ${localHash} (rule 4)`,
      );
    }
    log(`broadcast accepted: ${txHash}`);
    committed = { ...plan.pendingData, txHash };
    ctx.shared.pending[label] = committed;
    ctx.save();
  }

  await waitForCommit(ctx.client, committed.txHash, log);
  await finalize(committed);
  ctx.shared.steps[label] = true;
  delete ctx.shared.pending[label];
  ctx.save();
  return { txHash: committed.txHash, skipped: false };
}
