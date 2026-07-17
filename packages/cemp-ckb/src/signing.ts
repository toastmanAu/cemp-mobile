import {
  Address,
  CellDep,
  Script,
  Signer,
  SignerSignType,
  SignerType,
  Transaction,
  WitnessArgs,
  bytesFrom,
  hexFrom,
} from "@ckb-ccc/core";
import type { Client as CccClient, OutPoint, TransactionLike } from "@ckb-ccc/core";
import type { Script as CccScript } from "@ckb-ccc/core";
import { CKB_TESTNET } from "@cemp/core";
import type { CellDepRef, NetworkConfig } from "@cemp/core";
import {
  MLDSA_V2_SIZES,
  buildFinalMessage,
  cighashV2Digest,
  mldsaV2LockArgs,
  mldsaV2Sign,
  mldsaV2Verify,
  mldsaV2WitnessLock,
} from "@cemp/crypto";
import type { IdentityKeyBundle, MlDsa65KeyPair } from "@cemp/crypto";
import {
  MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN,
  buildCighashAllStream,
  buildPlaceholderWitness,
  withSignatureLock,
} from "./cighash.js";
import type { ResolvedInput } from "./cighash.js";
import { getMlDsaLockDeployment } from "./network.js";
import { CempCkbError } from "./client.js";

/**
 * ML-DSA-65 v2 transaction signer (`mldsa65-lock-v2-rust`), wiring the
 * pipeline documented in docs/grounding/mldsa-v2-signing-pipeline.md
 * end-to-end: placeholder witnesses → input resolution → CighashAll stream →
 * digest → FIPS-204 final message → hedged signature → witness lock splice.
 *
 * The signer doubles as a `ccc.Signer` so CCC's coin selection and fee
 * completion (`completeInputsByCapacity` / `completeFeeBy`) can run against
 * it; those CCC paths only ever exercise `findCells`, `getBalance` and
 * `prepareTransaction` — the secret key is used exclusively by
 * {@link MlDsaV2TxSigner.signTransaction}. Nothing here broadcasts.
 *
 * Witness layout contract (single script group, `[0..inputs.length)`):
 *
 *  - EVERY input index gets a placeholder witness with a 5,262-byte zero
 *    lock, preserving any existing inputType/outputType fields. The
 *    placeholder is installed by {@link MlDsaV2TxSigner.prepareTransaction}
 *    during fee completion (so the fee covers the full reserved size) and
 *    re-asserted by `signTransaction` (task step a).
 *  - Only the FIRST group witness receives the real signature lock. The
 *    remaining placeholder locks are part of the signed stream (the v2
 *    construction streams non-first group witnesses in full), so they must
 *    stay byte-identical between signing and broadcast — they cost
 *    ~5.3 KB of fee-sized witness per extra input, a deliberate
 *    simplification of multi-input spends (see the task report).
 *
 * Ordering contract (task step b): the caller MUST run coin selection / fee
 * completion BEFORE signing. Witnesses are not covered by `tx.hash`, so a
 * fee change after signing invalidates nothing cryptographically — but the
 * strict order keeps the signed stream identical to what the on-chain lock
 * recomputes.
 */

/** Resolves the live cell (CellOutput + data) behind an out point. */
export interface CellResolver {
  resolve(outPoint: OutPoint): Promise<ResolvedInput | undefined>;
}

/** Default resolver backed by a CCC client (`get_live_cell` under the hood). */
export function clientCellResolver(client: CccClient): CellResolver {
  return {
    async resolve(outPoint) {
      const cell = await client.getCellLive(outPoint, true);
      if (cell === undefined) {
        return undefined;
      }
      return { cellOutput: cell.cellOutput, data: bytesFrom(cell.outputData) };
    },
  };
}

/**
 * Offline resolver over a fixed set of cells (tests; reclaim flows where the
 * cells were discovered earlier and are journaled — AGENTS.md rule 5).
 */
export function staticCellResolver(
  cells: readonly {
    outPoint: OutPoint;
    cellOutput: ResolvedInput["cellOutput"];
    data: Uint8Array;
  }[],
): CellResolver {
  const keyOf = (outPoint: OutPoint) => `${outPoint.txHash}:${outPoint.index.toString()}`;
  const map = new Map(
    cells.map((cell) => [keyOf(cell.outPoint), { cellOutput: cell.cellOutput, data: cell.data }]),
  );
  return {
    resolve(outPoint) {
      return Promise.resolve(map.get(keyOf(outPoint)));
    },
  };
}

export interface MlDsaV2TxSignerOptions {
  /** The ML-DSA-65 keypair (1952-byte publicKey, 4032-byte secretKey). */
  keyPair: MlDsa65KeyPair;
  /** CCC client used for coin selection, fee completion and input resolution. */
  client: CccClient;
  /** Network configuration; defaults to CKB_TESTNET. Must have a pinned ML-DSA lock deployment. */
  network?: NetworkConfig;
}

export class MlDsaV2TxSigner extends Signer {
  readonly keyPair: MlDsa65KeyPair;
  readonly network: NetworkConfig;
  private readonly lockDeployment: CellDepRef;
  private readonly lock: CccScript;
  private readonly defaultResolver: CellResolver;

  constructor(options: MlDsaV2TxSignerOptions) {
    super(options.client);
    const { keyPair } = options;
    if (keyPair.secretKey.length !== MLDSA_V2_SIZES.sk) {
      throw new CempCkbError(
        "MlDsaV2TxSigner",
        `secretKey length ${keyPair.secretKey.length} != ${MLDSA_V2_SIZES.sk}`,
      );
    }
    // mldsaV2LockArgs validates the public key length.
    this.keyPair = keyPair;
    this.network = options.network ?? CKB_TESTNET;
    this.lockDeployment = getMlDsaLockDeployment(this.network);
    this.lock = Script.from({
      codeHash: this.lockDeployment.codeHash,
      hashType: this.lockDeployment.hashType,
      args: hexFrom(mldsaV2LockArgs(keyPair.publicKey)),
    });
    this.defaultResolver = clientCellResolver(options.client);
  }

  /** Convenience constructor from a derived identity bundle (spec §4–§5.1). */
  static fromIdentityKeys(
    bundle: IdentityKeyBundle,
    client: CccClient,
    network?: NetworkConfig,
  ): MlDsaV2TxSigner {
    return new MlDsaV2TxSigner({
      keyPair: bundle.mlDsa,
      client,
      ...(network !== undefined ? { network } : {}),
    });
  }

  /** The v2 lock script owned by this signer (37-byte args). */
  lockScript(): CccScript {
    return this.lock.clone();
  }

  /** The cell dep carrying the deployed v2 lock code (added to every tx). */
  lockCellDep(): CellDep {
    return CellDep.from({
      outPoint: { txHash: this.lockDeployment.txHash, index: this.lockDeployment.index },
      depType: this.lockDeployment.depType,
    });
  }

  // ── ccc.Signer interface ────────────────────────────────────────────────

  get type(): SignerType {
    return SignerType.CKB;
  }

  get signType(): SignerSignType {
    return SignerSignType.Unknown;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  isConnected(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async getInternalAddress(): Promise<string> {
    return (await this.getAddressObjs())[0]!.toString();
  }

  getAddressObjs(): Promise<Address[]> {
    return Promise.resolve([Address.fromScript(this.lock, this.client)]);
  }

  /**
   * Prepare a transaction for coin selection / fee completion: add the v2
   * lock cell dep and assert one placeholder witness per input index. Called
   * by CCC's `completeFee` loop, so it must be idempotent and must NOT touch
   * any already-present non-placeholder lock (e.g. a signature).
   *
   * Dual overloads for the same `exactOptionalPropertyTypes` reason as
   * {@link MlDsaV2TxSigner.signTransaction}.
   */
  override async prepareTransaction(txLike: TransactionLike): Promise<Transaction>;
  override async prepareTransaction(tx: Transaction): Promise<Transaction>;
  override async prepareTransaction(txLike: TransactionLike | Transaction): Promise<Transaction> {
    const tx = txLike instanceof Transaction ? txLike : Transaction.from(txLike);
    tx.addCellDeps(this.lockCellDep());
    ensurePlaceholderWitnesses(tx);
    return tx;
  }

  /**
   * Sign a transaction that is final apart from witness locks (coin
   * selection and fee completion already ran — see the module header for the
   * ordering contract). Pass a {@link CellResolver} for tests/offline
   * signing; the default resolves live cells through the CCC client.
   *
   * Two overloads because CCC's class instances do not satisfy their own
   * `*Like` types under this repo's `exactOptionalPropertyTypes` (the known
   * CCC 1.12.5 typing quirk): the first keeps the `ccc.Signer` contract, the
   * second is the ergonomic entry point for built `Transaction` objects.
   */
  override async signTransaction(txLike: TransactionLike): Promise<Transaction>;
  override async signTransaction(tx: Transaction, resolver?: CellResolver): Promise<Transaction>;
  override async signTransaction(
    txLike: TransactionLike | Transaction,
    resolver?: CellResolver,
  ): Promise<Transaction> {
    const tx = txLike instanceof Transaction ? txLike : Transaction.from(txLike);
    tx.addCellDeps(this.lockCellDep());
    ensurePlaceholderWitnesses(tx);
    return this.signPreparedTransaction(tx, resolver ?? this.defaultResolver);
  }

  /** CCC signing entry point (prepare already ran upstream). */
  override async signOnlyTransaction(txLike: TransactionLike): Promise<Transaction> {
    const tx = Transaction.from(txLike);
    return this.signPreparedTransaction(tx, this.defaultResolver);
  }

  // ── v2 signing flow ─────────────────────────────────────────────────────

  private async signPreparedTransaction(
    tx: Transaction,
    resolver: CellResolver,
  ): Promise<Transaction> {
    const inputCount = tx.inputs.length;
    if (inputCount === 0) {
      throw new CempCkbError("signTransaction", "transaction has no inputs");
    }
    // (c) Resolve every input's CellOutput + data, in tx.inputs order.
    const resolvedInputs: ResolvedInput[] = [];
    for (let i = 0; i < inputCount; i++) {
      const outPoint = tx.inputs[i]!.previousOutput;
      const resolved = await resolver.resolve(outPoint);
      if (resolved === undefined) {
        throw new CempCkbError(
          "signTransaction",
          `input ${i} (${outPoint.txHash}:${outPoint.index.toString()}) is not a live cell`,
        );
      }
      resolvedInputs.push(resolved);
    }
    // (d) Single script group [0..inputs.length): stream → digest → M' → sign.
    const groupInputIndices = tx.inputs.map((_, i) => i);
    const stream = buildCighashAllStream(tx, resolvedInputs, groupInputIndices);
    const finalMessage = buildFinalMessage(cighashV2Digest(stream));
    // Hedged signing: no random override (grounding §Digest and framing).
    const signature = mldsaV2Sign(this.keyPair.secretKey, finalMessage);
    const witnessLock = mldsaV2WitnessLock(this.keyPair.publicKey, signature);
    // Splice into the FIRST group witness only (see the module header).
    const firstWitness = tx.getWitnessArgsAt(0);
    if (firstWitness === undefined) {
      throw new CempCkbError("signTransaction", "witness 0 missing after placeholder assertion");
    }
    tx.setWitnessArgsAt(0, withSignatureLock(firstWitness, witnessLock));
    return tx;
  }

  /**
   * Re-verify this signer's signature on a signed transaction: rebuild the
   * CighashAll stream from the CURRENT witnesses and run FIPS-204 verify.
   * Returns false (never throws) for missing/malformed witness locks and for
   * any post-signing tampering (tx.hash is covered by the stream). Used in
   * tests and as a pre-broadcast self-check.
   */
  verifyOwnSignature(tx: Transaction, resolvedInputs: ResolvedInput[]): boolean {
    if (tx.inputs.length === 0 || tx.witnesses.length === 0) {
      return false;
    }
    let witness: WitnessArgs;
    try {
      const parsed = tx.getWitnessArgsAt(0);
      if (parsed === undefined || parsed.lock === undefined) {
        return false;
      }
      witness = parsed;
    } catch {
      return false;
    }
    const lock = bytesFrom(witness.lock!);
    if (lock.length !== MLDSA_V2_SIZES.witnessLock || lock[0] !== 0x7b) {
      return false;
    }
    const publicKey = lock.subarray(1, 1 + MLDSA_V2_SIZES.pk);
    const signature = lock.subarray(1 + MLDSA_V2_SIZES.pk);
    if (!bytesEqual(publicKey, this.keyPair.publicKey)) {
      return false;
    }
    const groupInputIndices = tx.inputs.map((_, i) => i);
    const stream = buildCighashAllStream(tx, resolvedInputs, groupInputIndices);
    const finalMessage = buildFinalMessage(cighashV2Digest(stream));
    return mldsaV2Verify(publicKey, finalMessage, signature);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function isZeroPlaceholderLock(lockHex: string): boolean {
  const lock = bytesFrom(lockHex);
  return lock.length === MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN && lock.every((byte) => byte === 0);
}

/**
 * Assert one placeholder witness per input index, preserving any existing
 * non-lock witness fields and any non-placeholder lock. Extra witnesses
 * beyond the input count are left untouched (they are streamed in full by
 * the CighashAll construction).
 */
export function ensurePlaceholderWitnesses(tx: Transaction): void {
  while (tx.witnesses.length < tx.inputs.length) {
    tx.witnesses.push("0x");
  }
  for (let i = 0; i < tx.inputs.length; i++) {
    const raw = tx.witnesses[i]!;
    let existing: WitnessArgs | undefined;
    if (raw !== "0x") {
      try {
        existing = WitnessArgs.fromBytes(bytesFrom(raw));
      } catch (err) {
        throw new CempCkbError(
          "ensurePlaceholderWitnesses",
          `witness ${i} is not a WitnessArgs molecule`,
          { cause: err },
        );
      }
    }
    if (existing?.lock !== undefined && !isZeroPlaceholderLock(existing.lock)) {
      // A real lock (e.g. an existing signature) is never clobbered here.
      continue;
    }
    const placeholder = buildPlaceholderWitness();
    tx.setWitnessArgsAt(
      i,
      WitnessArgs.from({
        lock: placeholder.lock!,
        inputType: existing?.inputType ?? null,
        outputType: existing?.outputType ?? null,
      }),
    );
  }
}
