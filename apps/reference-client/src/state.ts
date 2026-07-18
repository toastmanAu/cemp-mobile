import fs from "node:fs";
import path from "node:path";
import type { IdentityName } from "./identities.js";

/**
 * Local run state (AGENTS.md rules 5 and 8): one JSON file per identity plus
 * a shared file, checkpointed after EVERY step so a resumed run skips
 * completed steps and never repeats a broadcast. Everything here is public
 * or ciphertext material — plaintext message content is NEVER persisted
 * (rule 3); decrypted text goes to stdout only.
 *
 * Layout under --state-dir (default ./.cemp-state):
 *
 *   alice.json / bob.json — per-identity state (history is kept, rule 8)
 *   shared.json           — step checkpoints, deployment, profile ids, mappings
 *   journal/<label>.json  — pre-broadcast transaction journals (rule 6)
 */

/** Hex uint32 out-point reference, as used by CKB RPC. */
export interface OutPointJson {
  txHash: string;
  index: string;
}

/** Shannons as decimal strings (JSON-safe bigints). */
export interface BalanceSnapshot {
  /** Sum of ALL live cells under the lock. */
  total: string;
  /** Sum of cells with no type script and empty data (plain wallet balance). */
  spendable: string;
}

export type MessageStatus =
  | "published" // sent by us, committed on-chain
  | "received" // discovered + decrypted by us
  | "acknowledged" // our sent message was answered with a valid reply
  | "reclaimed" // we consumed the cell back (sender only, rule 9)
  | "remote_reclaimed"; // the sender consumed it; history record KEPT (rule 8)

export interface MessageRecord {
  /** 16-byte message id, lowercase hex. */
  messageId: string;
  direction: "sent" | "received";
  /** Peer profile id, lowercase hex. */
  peerProfileId: string;
  txHash: string;
  outPoint: OutPointJson;
  status: MessageStatus;
  recordedAt: string;
}

export interface IdentityState {
  version: 1;
  identity: IdentityName;
  handle: string;
  address: string;
  lockArgs: string;
  lockScriptHash: string;
  /** 16-byte device id (spec §2), hex, generated once and persisted. */
  deviceId: string;
  balanceBefore: BalanceSnapshot | null;
  /** Live balances captured by the reconcile step (reporting only). */
  balanceAfter: BalanceSnapshot | null;
  /** Broadcast label → fee in shannons (decimal). */
  fees: Record<string, string>;
  profileId: string | null;
  profileOutPoint: OutPointJson | null;
  /** Profile cell capacity in shannons (decimal). */
  profileCapacity: string | null;
  /** Local message history — never deleted (rule 8). No plaintext. */
  messages: MessageRecord[];
  /** Outpoints (`txHash:index`) already processed by discovery (spec §12.4: never retry invalid cells). */
  processedCells: string[];
}

/** Deployment record, mirroring contracts/deployment/README.md. */
export interface DeploymentRecord {
  network: "ckb_testnet";
  contract: "cemp-message-type";
  version: string;
  deployTxHash: string;
  outPointIndex: number;
  codeHash: string;
  hashType: "data1";
  deployedAt: string;
  sourceCommit: string;
  notes: string;
}

export interface MessageMapping {
  /** 16-byte message id, hex. */
  messageId: string;
  from: IdentityName;
  to: IdentityName;
  txHash: string;
  outPoint: OutPointJson;
  routeTag: string;
  conversationId: string;
  /** Message cell capacity in shannons (decimal). */
  capacity: string;
  /** Fee paid by the sender, shannons (decimal). */
  fee: string;
}

export interface ProfileRecord {
  profileId: string;
  /** ML-KEM-768 public key, hex — the fingerprint re-checked on resolution. */
  kemPublicKey: string;
  /** Profile cell capacity in shannons (decimal). */
  capacity: string;
}

export interface SharedState {
  version: 1;
  /** Step-name markers; presence means the step completed (rule 5). */
  steps: Record<string, true>;
  /**
   * Broadcasts written to the journal and sent but not yet checkpointed
   * (crash between `send_transaction` and commit). A resumed step waits for
   * the recorded hash instead of rebuilding and double-broadcasting.
   */
  pending: Record<string, { txHash: string } & Record<string, unknown>>;
  deployment: DeploymentRecord | null;
  /** Contract cell capacity in shannons (decimal), for reconciliation. */
  contractCellCapacity: string | null;
  profiles: { alice: ProfileRecord | null; bob: ProfileRecord | null };
  messages: { aliceToBob: MessageMapping | null; bobToAlice: MessageMapping | null };
  /** Alice's rotation record (rotate step); null until the first rotation. */
  rotation: RotationRecord | null;
}

/** What the rotate step proved on-chain (verify-rotation consumes it). */
export interface RotationRecord {
  oldProfileId: string;
  oldMlDsaPublicKey: string;
  oldKemPublicKey: string;
  /** The retired profile cell's outpoint (spent by the rotation tx). Optional for legacy records. */
  oldOutPoint?: OutPointJson;
  newProfileId: string;
  txHash: string;
}

// ── construction ────────────────────────────────────────────────────────────

export function defaultSharedState(): SharedState {
  return {
    version: 1,
    steps: {},
    pending: {},
    deployment: null,
    contractCellCapacity: null,
    profiles: { alice: null, bob: null },
    messages: { aliceToBob: null, bobToAlice: null },
    rotation: null,
  };
}

export function defaultIdentityState(
  identity: IdentityName,
  derived: {
    handle: string;
    address: string;
    lockArgs: string;
    lockScriptHash: string;
    deviceId: string;
  },
): IdentityState {
  return {
    version: 1,
    identity,
    ...derived,
    balanceBefore: null,
    balanceAfter: null,
    fees: {},
    profileId: null,
    profileOutPoint: null,
    profileCapacity: null,
    messages: [],
    processedCells: [],
  };
}

// ── persistence (atomic write: tmp file + rename) ───────────────────────────

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`state file ${file} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function asRecord(value: unknown, file: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`state file ${file} does not contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

export class StateStore {
  readonly dir: string;
  readonly journalDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.journalDir = path.join(dir, "journal");
  }

  identityPath(name: IdentityName): string {
    return path.join(this.dir, `${name}.json`);
  }

  get sharedPath(): string {
    return path.join(this.dir, "shared.json");
  }

  ensureDirs(): void {
    fs.mkdirSync(this.journalDir, { recursive: true });
  }

  sharedExists(): boolean {
    return fs.existsSync(this.sharedPath);
  }

  identityExists(name: IdentityName): boolean {
    return fs.existsSync(this.identityPath(name));
  }

  loadShared(): SharedState {
    const rec = asRecord(readJson(this.sharedPath), this.sharedPath);
    if (rec.version !== 1) {
      throw new Error(`${this.sharedPath}: unsupported state version ${String(rec.version)}`);
    }
    return rec as unknown as SharedState;
  }

  loadIdentity(name: IdentityName): IdentityState {
    const file = this.identityPath(name);
    const rec = asRecord(readJson(file), file);
    if (rec.version !== 1 || rec.identity !== name) {
      throw new Error(`${file}: version/identity mismatch — refusing to guess (delete to reset)`);
    }
    return rec as unknown as IdentityState;
  }

  saveShared(state: SharedState): void {
    this.ensureDirs();
    writeJsonAtomic(this.sharedPath, state);
  }

  saveIdentity(state: IdentityState): void {
    this.ensureDirs();
    writeJsonAtomic(this.identityPath(state.identity), state);
  }
}

/**
 * Checkpoint helper (rule 5): run `fn` only when `name` is not yet marked in
 * `shared.steps`; on completion mark and save. A resumed run skips completed
 * steps, so every step body must be safe to skip (its results live in state).
 */
export async function runCheckpointed<T>(
  store: StateStore,
  shared: SharedState,
  name: string,
  fn: () => Promise<T>,
): Promise<{ ran: boolean; result: T | undefined }> {
  if (shared.steps[name] === true) {
    return { ran: false, result: undefined };
  }
  const result = await fn();
  shared.steps[name] = true;
  store.saveShared(shared);
  return { ran: true, result };
}
