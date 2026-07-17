import { CellDep, KnownScript, Transaction, hashTypeId, hexFrom, numFrom } from "@ckb-ccc/core";
import type { Client as CccClient, NumLike, Script, ScriptLike } from "@ckb-ccc/core";
import { codec } from "@cemp/core";
import { CempCkbError } from "./client.js";
import type { MlDsaV2TxSigner } from "./signing.js";
import type { Cell, HashType } from "./types.js";

/**
 * Transaction builders for the headless reference client (spec §5–§7). Each
 * builder returns the unsigned-but-complete transaction plus a
 * journal-friendly description so the caller can persist a pre-broadcast
 * journal entry (AGENTS.md rule 6) before signing and (in the next task)
 * broadcasting. Nothing in this module broadcasts.
 *
 * Flow per builder (grounding: docs/grounding/ckb-knowledge-graph-routes.md
 * Route 2, mirroring reference/cemp-pq with the v1 codec and v2 lock):
 *
 *  1. `ccc.Transaction.from({ outputs, outputsData })` — CCC 1.12.5
 *     auto-sizes a zero-capacity output to its occupied size when outputData
 *     is given; {@link CAPACITY_MARGIN} is added on top.
 *  2. `completeInputsByCapacity(signer)` — coin selection over the signer's
 *     lock cells.
 *  3. `completeFeeBy` / `completeFeeChangeToLock(signer, …)` — fee completion;
 *     internally runs `signer.prepareTransaction`, which adds the v2 lock
 *     cell dep and the 5,262-byte placeholder witnesses that size the fee.
 *
 * Signing is a separate step (`MlDsaV2TxSigner.signTransaction`) AFTER the
 * builder returns (the signed stream must equal the final byte layout).
 */

/** Default fee rate in shannons per 1000 bytes (matches reference/cemp-pq). */
export const DEFAULT_FEE_RATE = 1200n;

/**
 * Headroom added to every created cell above its occupied size, in shannons
 * (1 CKB). Keeps small later data/capacity adjustments possible without a
 * resize and avoids pinning cells to the exact occupied minimum.
 */
export const CAPACITY_MARGIN = 100_000_000n;

/**
 * Well-known Type ID system script code hash (genesis script, identical on
 * every CKB network — the trailing bytes are ASCII "TYPE_ID"). Used for the
 * profile cell's Type ID (spec §5.3: the Type ID args are the profile_id).
 */
export const TYPE_ID_CODE_HASH =
  "0x00000000000000000000000000000000000000000000000000545950455f4944";

/**
 * Message-cell type args layout (spec §6): version ‖ route_tag ‖
 * conversation_tag ‖ message_nonce, 81 bytes total.
 *
 * ⚠ SPEC FRICTION (reported, not silently worked around): the spec §6
 * heading says "81 bytes, fixed" — and the transaction-layer task pins the
 * same 81 — but the field list it gives (1 + 32 + 16 + 16) sums to 65.
 * Until the spec is corrected (either the total drops to 65 or the trailing
 * field is documented), this layout writes the four documented fields in
 * order and zero-fills the remaining 16 bytes as a RESERVED suffix. The
 * 33-byte discovery prefix (version ‖ route_tag) is unaffected either way,
 * and the args carry a version byte exactly so this layout can be revised.
 * No golden vector exists for these args yet (spec §14); one must be added
 * with the spec fix.
 */
export const MESSAGE_TYPE_ARGS = {
  version: 0x01,
  routeTagBytes: 32,
  conversationTagBytes: 16,
  messageNonceBytes: 16,
  /** Trailing zero-filled bytes; see the discrepancy note above. */
  reservedBytes: 16,
  totalBytes: 81,
} as const;

/** JSON-safe description of one resolved input, for the pre-broadcast journal. */
export interface ResolvedInputDescription {
  txHash: string;
  /** Hex-encoded uint32 index, as used by CKB RPC. */
  index: string;
  /** Capacity in shannons, decimal string (JSON-safe bigint). */
  capacity: string;
}

/** Journal-friendly builder result (AGENTS.md rule 6). */
export interface BuiltTransaction {
  tx: Transaction;
  resolvedInputsDescription: ResolvedInputDescription[];
  /** Inputs minus outputs, in shannons, after fee completion. */
  estimatedFee: bigint;
}

/**
 * Out-point reference to a deployed script code cell (hex index, as used by
 * CKB RPC). Any script that EXECUTES in a transaction — lock scripts of
 * inputs, type scripts of inputs AND outputs — must be resolvable through
 * the transaction's cell deps, so every builder that creates or spends a
 * cell carrying a CEMP script takes the matching reference explicitly
 * (deployed contract identifiers come from `@cemp/core` network
 * configuration / deployment records, never hard-coded — AGENTS.md).
 */
export interface ScriptCellDepRef {
  txHash: string;
  /** Hex-encoded uint32 index, as used by CKB RPC. */
  index: string;
  depType: "code" | "depGroup";
}

/**
 * The deployed CEMP message type script. `cellDep` is REQUIRED (not
 * optional): the type script executes on every message send and on every
 * reclaim, and without its code cell in the transaction's cell deps the
 * transaction fails on-chain.
 */
export interface CempMessageTypeRef {
  codeHash: string;
  hashType: HashType;
  cellDep: ScriptCellDepRef;
}

const U32_MAX = 0xff_ff_ff_ffn;

function cellDepFrom(ref: ScriptCellDepRef, ctx: string): CellDep {
  if (!/^0x[0-9a-fA-F]{64}$/.test(ref.txHash)) {
    throw new CempCkbError(ctx, `cell dep tx hash is not a 32-byte hash: ${ref.txHash}`);
  }
  let index: bigint;
  try {
    index = numFrom(ref.index);
  } catch (err) {
    throw new CempCkbError(ctx, `cell dep index ${JSON.stringify(ref.index)} is unparseable`, {
      cause: err,
    });
  }
  if (index > U32_MAX) {
    throw new CempCkbError(ctx, `cell dep index ${ref.index} exceeds uint32`);
  }
  return CellDep.from({ outPoint: { txHash: ref.txHash, index }, depType: ref.depType });
}

async function describeInputs(
  tx: Transaction,
  client: CccClient,
): Promise<ResolvedInputDescription[]> {
  const descriptions: ResolvedInputDescription[] = [];
  for (const input of tx.inputs) {
    const { cellOutput } = await input.getCell(client);
    descriptions.push({
      txHash: input.previousOutput.txHash,
      index: `0x${input.previousOutput.index.toString(16)}`,
      capacity: cellOutput.capacity.toString(),
    });
  }
  return descriptions;
}

async function finalize(tx: Transaction, client: CccClient): Promise<BuiltTransaction> {
  const estimatedFee = await tx.getFee(client);
  if (estimatedFee <= 0n) {
    throw new CempCkbError("builders", `fee completion left a non-positive fee (${estimatedFee})`);
  }
  return { tx, resolvedInputsDescription: await describeInputs(tx, client), estimatedFee };
}

// ── create profile (spec §5) ────────────────────────────────────────────────

export interface BuildCreateProfileTxOptions {
  /** Profile fields; encoded with the v1 codec inside the builder. */
  profile: codec.CempProfileV1Encodable;
  /** Signer owning the new profile cell (its lock becomes the cell lock). */
  signer: MlDsaV2TxSigner;
  feeRate?: NumLike;
}

/**
 * One output cell: lock = signer lock, type = Type ID script whose args are
 * `hashTypeId(firstInput, 0)` (the profile_id, spec §5.3), data = the
 * codec-encoded `CempProfileV1`. Change goes back to the signer lock.
 *
 * The Type ID script executes on creation, so its code cell is added to the
 * transaction's cell deps (`KnownScript.TypeId`, resolved by the network's
 * CCC client — the genesis system script, present on every CKB network).
 */
export async function buildCreateProfileTx(
  options: BuildCreateProfileTxOptions,
): Promise<BuiltTransaction> {
  const { signer } = options;
  const data = codec.encodeCempProfileV1(options.profile);
  const validation = codec.validateProfile(data);
  if (!validation.ok) {
    throw new CempCkbError("buildCreateProfileTx", `profile rejected: ${validation.reason}`);
  }

  const tx = Transaction.from({
    outputs: [
      {
        lock: signer.lockScript(),
        type: {
          codeHash: TYPE_ID_CODE_HASH,
          hashType: "type",
          // Placeholder; replaced with the Type ID args after coin selection.
          args: hexFrom(new Uint8Array(32)),
        },
        capacity: 0,
      },
    ],
    outputsData: [hexFrom(data)],
  });
  // The Type ID script runs for the new output: its code must be in cell deps.
  await tx.addCellDepsOfKnownScripts(signer.client, KnownScript.TypeId);
  const profileOutput = tx.outputs[0];
  if (profileOutput === undefined) {
    throw new CempCkbError("buildCreateProfileTx", "internal: profile output missing");
  }
  profileOutput.capacity += CAPACITY_MARGIN;

  await tx.completeInputsByCapacity(signer);
  const firstInput = tx.inputs[0];
  if (firstInput === undefined) {
    throw new CempCkbError("buildCreateProfileTx", "coin selection added no inputs");
  }
  // Type ID over the FIRST input (fixed by the appends-only coin selection
  // above) at output index 0 — the stable profile identity (spec §5.3).
  // A fresh literal is passed because CCC's class instances do not satisfy
  // its own `CellInputLike` under exactOptionalPropertyTypes (the same CCC
  // 1.12.5 typing quirk cemp-core works around in codec/codecs.ts).
  const typeArgs = hashTypeId({ previousOutput: firstInput.previousOutput }, 0);
  const typeScript = profileOutput.type;
  if (typeScript === undefined) {
    throw new CempCkbError("buildCreateProfileTx", "internal: type script missing");
  }
  typeScript.args = typeArgs;

  await tx.completeFeeBy(signer, options.feeRate ?? DEFAULT_FEE_RATE);
  return finalize(tx, signer.client);
}

// ── send message (spec §6–§7) ───────────────────────────────────────────────

export interface BuildSendMessageTxOptions {
  /** Codec-encoded `CempEnvelopeV1` cell data (≤ 82,000 bytes, spec §11). */
  envelopeBytes: Uint8Array;
  routeTag: Uint8Array;
  conversationTag: Uint8Array;
  messageNonce: Uint8Array;
  /** Sender (owner) of the message cell — the sender keeps reclaim authority (rule 9). */
  sender: MlDsaV2TxSigner;
  /**
   * Deployed CEMP message type script, including its code cell dep (see
   * {@link CempMessageTypeRef} for why the dep is required). Null is a hard
   * error: discovery depends on the type script, so this builder never
   * silently sends without it.
   */
  cempMessageType: CempMessageTypeRef | null;
  feeRate?: NumLike;
}

/** Fixed 81-byte message-cell type args (spec §6 — see the discrepancy note on {@link MESSAGE_TYPE_ARGS}). */
export function buildMessageTypeArgs(
  routeTag: Uint8Array,
  conversationTag: Uint8Array,
  messageNonce: Uint8Array,
): Uint8Array {
  const sizes = MESSAGE_TYPE_ARGS;
  if (routeTag.length !== sizes.routeTagBytes) {
    throw new CempCkbError(
      "buildMessageTypeArgs",
      `route_tag is ${routeTag.length} bytes, expected 32`,
    );
  }
  if (conversationTag.length !== sizes.conversationTagBytes) {
    throw new CempCkbError(
      "buildMessageTypeArgs",
      `conversation_tag is ${conversationTag.length} bytes, expected 16`,
    );
  }
  if (messageNonce.length !== sizes.messageNonceBytes) {
    throw new CempCkbError(
      "buildMessageTypeArgs",
      `message_nonce is ${messageNonce.length} bytes, expected 16`,
    );
  }
  // Uint8Array zero-init covers the 16 reserved trailing bytes (see above).
  const out = new Uint8Array(sizes.totalBytes);
  out[0] = sizes.version;
  out.set(routeTag, 1);
  out.set(conversationTag, 1 + sizes.routeTagBytes);
  out.set(messageNonce, 1 + sizes.routeTagBytes + sizes.conversationTagBytes);
  return out;
}

/**
 * One output cell: lock = sender lock, type = the network's CEMP message
 * type script with the 81-byte args layout, data = `CempEnvelopeV1` bytes.
 */
export async function buildSendMessageTx(
  options: BuildSendMessageTxOptions,
): Promise<BuiltTransaction> {
  if (options.cempMessageType === null) {
    throw new CempCkbError(
      "buildSendMessageTx",
      "no CEMP message type script is deployed on this network " +
        "(deployments.cempMessageType is null) — refusing to build a message cell " +
        "without the discovery type script (spec §6)",
    );
  }
  if (options.envelopeBytes.length === 0) {
    throw new CempCkbError("buildSendMessageTx", "envelope is empty");
  }
  if (options.envelopeBytes.length > codec.V1_LIMITS.maxEnvelopeBytes) {
    throw new CempCkbError(
      "buildSendMessageTx",
      `envelope is ${options.envelopeBytes.length} bytes, exceeds the ` +
        `${codec.V1_LIMITS.maxEnvelopeBytes}-byte limit (spec §11)`,
    );
  }
  const validation = codec.validateEnvelope(options.envelopeBytes);
  if (!validation.ok) {
    throw new CempCkbError("buildSendMessageTx", `envelope rejected: ${validation.reason}`);
  }
  const typeArgs = buildMessageTypeArgs(
    options.routeTag,
    options.conversationTag,
    options.messageNonce,
  );

  const tx = Transaction.from({
    outputs: [
      {
        lock: options.sender.lockScript(),
        type: {
          codeHash: options.cempMessageType.codeHash,
          hashType: options.cempMessageType.hashType,
          args: hexFrom(typeArgs),
        },
        capacity: 0,
      },
    ],
    outputsData: [hexFrom(options.envelopeBytes)],
  });
  // The type script executes on the new output: code must be in cell deps.
  tx.addCellDeps(cellDepFrom(options.cempMessageType.cellDep, "buildSendMessageTx"));
  const messageOutput = tx.outputs[0];
  if (messageOutput === undefined) {
    throw new CempCkbError("buildSendMessageTx", "internal: message output missing");
  }
  messageOutput.capacity += CAPACITY_MARGIN;

  await tx.completeInputsByCapacity(options.sender);
  await tx.completeFeeBy(options.sender, options.feeRate ?? DEFAULT_FEE_RATE);
  return finalize(tx, options.sender.client);
}

// ── reclaim (spec §7.3, rule 9) ─────────────────────────────────────────────

export interface OutPointRef {
  txHash: string;
  index: string;
}

export interface BuildReclaimTxOptions {
  /** Out points of the live message cells being reclaimed (sender-owned). */
  outpoints: OutPointRef[];
  /**
   * The previously discovered live cells behind `outpoints` (same order,
   * same length) — e.g. from `findMessageCells` / the reclaim journal.
   * Passed in explicitly so reclaim stays idempotent and offline-capable
   * (AGENTS.md rules 5, 8).
   */
  resolvedCells: Cell[];
  /** Signer (the sender); only cells locked by ITS lock may be reclaimed (rule 9). */
  signer: MlDsaV2TxSigner;
  /**
   * Code cell dep of the CEMP message type script. REQUIRED: the reclaimed
   * cells carry that type script, which executes when they are spent, so its
   * code must be resolvable through the transaction's cell deps.
   */
  messageTypeCellDep: ScriptCellDepRef;
  /** Consolidation target; defaults to the signer's own lock. */
  recipientLock?: ScriptLike;
  feeRate?: NumLike;
}

/**
 * Consume the given live cells and consolidate their capacity into a single
 * output to the recipient lock (the change output created by fee completion).
 * Witness handling is the same single-group signer flow as every other
 * builder: `prepareTransaction` asserts one placeholder per input.
 */
export async function buildReclaimTx(options: BuildReclaimTxOptions): Promise<BuiltTransaction> {
  const { outpoints, resolvedCells, signer } = options;
  if (outpoints.length === 0) {
    throw new CempCkbError("buildReclaimTx", "no out points given");
  }
  if (outpoints.length !== resolvedCells.length) {
    throw new CempCkbError(
      "buildReclaimTx",
      `${outpoints.length} out points but ${resolvedCells.length} resolved cells`,
    );
  }
  const ownerLock = signer.lockScript();
  const inputs = outpoints.map((outPoint, i) => {
    let index: bigint;
    try {
      index = numFrom(outPoint.index);
    } catch (err) {
      throw new CempCkbError(
        "buildReclaimTx",
        `out point ${i} has an unparseable index ${JSON.stringify(outPoint.index)}`,
        { cause: err },
      );
    }
    const cell = resolvedCells[i]!;
    const matches =
      cell.outPoint.txHash === outPoint.txHash && sameIndex(cell.outPoint.index, outPoint.index);
    if (!matches) {
      throw new CempCkbError(
        "buildReclaimTx",
        `resolved cell ${i} does not match out point ${outPoint.txHash}:${outPoint.index}`,
      );
    }
    if (!scriptEquals(cell.output.lock, ownerLock)) {
      throw new CempCkbError(
        "buildReclaimTx",
        `cell ${i} (${outPoint.txHash}:${outPoint.index}) is not locked by the sender's lock — ` +
          "reclaim authority stays with the sender (AGENTS.md rule 9)",
      );
    }
    return { previousOutput: { txHash: outPoint.txHash, index }, since: 0 };
  });

  const tx = Transaction.from({ inputs, outputs: [], outputsData: [] });
  // The spent message cells' type script executes: code must be in cell deps.
  tx.addCellDeps(cellDepFrom(options.messageTypeCellDep, "buildReclaimTx"));
  const recipientLock = options.recipientLock ?? ownerLock;
  // The consolidation output is the change cell created here; the sender may
  // top up with extra wallet inputs if the reclaimed capacity cannot cover
  // the fee (CCC default shouldAddInputs: true).
  await tx.completeFeeChangeToLock(signer, recipientLock, options.feeRate ?? DEFAULT_FEE_RATE);

  // Journal description comes straight from the provided cells (offline).
  const resolvedInputsDescription = resolvedCells.map((cell) => ({
    txHash: cell.outPoint.txHash,
    index: cell.outPoint.index,
    capacity: numFrom(cell.output.capacity).toString(),
  }));
  const estimatedFee = await tx.getFee(signer.client);
  if (estimatedFee <= 0n) {
    throw new CempCkbError(
      "buildReclaimTx",
      `fee completion left a non-positive fee (${estimatedFee})`,
    );
  }
  return { tx, resolvedInputsDescription, estimatedFee };
}

function sameIndex(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

function scriptEquals(a: { codeHash: string; hashType: string; args: string }, b: Script): boolean {
  return a.codeHash === b.codeHash && a.hashType === b.hashType && a.args === b.args;
}

// ── deploy data cell (contract deployment) ──────────────────────────────────

export interface BuildDeployDataCellTxOptions {
  /** The cell data — e.g. the compiled contract binary. */
  data: Uint8Array;
  /** Owner of the deployed code cell (its lock becomes the cell lock). */
  signer: MlDsaV2TxSigner;
  feeRate?: NumLike;
}

/**
 * One output cell: lock = signer lock, NO type script, data = the given bytes
 * (a `data1`-hashable code cell, per contracts/deployment/README.md). The
 * data itself never executes in this transaction, so the only script dep is
 * the signer's lock dep (added by `prepareTransaction` during fee
 * completion). Capacity is the occupied size plus {@link CAPACITY_MARGIN} —
 * the cell stays locked permanently, so the margin is a one-time cost.
 */
export async function buildDeployDataCellTx(
  options: BuildDeployDataCellTxOptions,
): Promise<BuiltTransaction> {
  if (options.data.length === 0) {
    throw new CempCkbError("buildDeployDataCellTx", "refusing to deploy an empty data cell");
  }
  const tx = Transaction.from({
    outputs: [{ lock: options.signer.lockScript(), capacity: 0 }],
    outputsData: [hexFrom(options.data)],
  });
  const output = tx.outputs[0];
  if (output === undefined) {
    throw new CempCkbError("buildDeployDataCellTx", "internal: deploy output missing");
  }
  output.capacity += CAPACITY_MARGIN;

  await tx.completeInputsByCapacity(options.signer);
  await tx.completeFeeBy(options.signer, options.feeRate ?? DEFAULT_FEE_RATE);
  return finalize(tx, options.signer.client);
}
