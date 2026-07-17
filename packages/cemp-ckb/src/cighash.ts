import { bytesFrom, hexFrom } from "@ckb-ccc/core";
import type { CellOutput, Transaction, WitnessArgs } from "@ckb-ccc/core";
import { WitnessArgs as WitnessArgsCodec } from "@ckb-ccc/core";

/**
 * CighashAll byte-stream builder for the v2 ML-DSA-65 lock
 * (`mldsa65-lock-v2-rust`) — the CCC-dependent half of the signing pipeline
 * documented in docs/grounding/mldsa-v2-signing-pipeline.md. The digest /
 * final-message / signature half lives in @cemp/crypto (src/mldsa-v2.ts);
 * the two halves are joined only by byte arrays.
 *
 * Layout (mirrors tools/signing-harness/src/ckb_tx_message_all_host.rs,
 * which is byte-identical to the on-chain ckb_tx_message_all_in_ckb_vm):
 *
 * ```text
 * stream = tx_hash                                                       // 32 B
 *        || for each resolved input, in tx.inputs order:
 *               cell_output.toBytes() || u32_le(data.len()) || data
 *        || first group witness, SPLIT (lock excluded — it is the signature):
 *               u32_le(len(input_type_slice))  || input_type_slice
 *               u32_le(len(output_type_slice)) || output_type_slice
 *        || for each remaining group-input witness (skip 1):
 *               u32_le(len) || full_witness_bytes
 *        || for each witness at index >= tx.inputs.length:
 *               u32_le(len) || full_witness_bytes
 * ```
 *
 * All length prefixes are u32 LITTLE-ENDIAN — NOT the u64 of classic
 * sighash-all (CkbTxMessageAll differs from SighashAll here).
 */

/** Witness-lock length reserved by the placeholder: 1 flag + 1952 pk + 3309 sig. */
export const MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN = 5262;

/** One resolved input cell: the molecule CellOutput plus its data. */
export interface ResolvedInput {
  cellOutput: CellOutput;
  data: Uint8Array;
}

function u32le(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
    throw new Error(`CighashAll segment length ${length} does not fit u32`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, length, true);
  return out;
}

/**
 * Raw molecule BytesOpt encoding of a WitnessArgs field: None → zero bytes;
 * Some(b) → u32_le(len(b)) || b. This is the slice the Rust host streams
 * (`WitnessArgsReader::input_type().as_slice()`), NOT the bare field bytes.
 */
function bytesOptSlice(value: `0x${string}` | undefined): Uint8Array {
  if (value === undefined) {
    return new Uint8Array(0);
  }
  const bytes = bytesFrom(value);
  const out = new Uint8Array(4 + bytes.length);
  out.set(u32le(bytes.length), 0);
  out.set(bytes, 4);
  return out;
}

/**
 * Build the CighashAll stream for a script group.
 * See docs/grounding/mldsa-v2-signing-pipeline.md §CighashAll stream.
 *
 * @param tx - Transaction being signed. The lock field of
 *   `witnesses[groupInputIndices[0]]` is not inspected (it is the signature).
 * @param resolvedInputs - One CellOutput + data per `tx.inputs` entry, in order.
 * @param groupInputIndices - Indices into `tx.inputs` (equivalently
 *   `tx.witnesses`) of the inputs in the current script group.
 */
export function buildCighashAllStream(
  tx: Transaction,
  resolvedInputs: ResolvedInput[],
  groupInputIndices: number[],
): Uint8Array {
  const inputCount = tx.inputs.length;
  if (resolvedInputs.length !== inputCount) {
    throw new Error(
      `buildCighashAllStream: ${resolvedInputs.length} resolved inputs for ${inputCount} tx inputs`,
    );
  }
  if (groupInputIndices.length === 0) {
    throw new Error("buildCighashAllStream: empty group input indices");
  }
  const witnessCount = tx.witnesses.length;
  for (const idx of groupInputIndices) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= witnessCount) {
      throw new Error(
        `buildCighashAllStream: group index ${idx} out of range (witness count ${witnessCount})`,
      );
    }
  }

  const parts: Uint8Array[] = [];

  // 1. tx_hash (32 B) — raw-tx hash; witnesses are not covered by it.
  parts.push(bytesFrom(tx.hash()));

  // 2. Resolved inputs in tx.inputs order: CellOutput bytes + prefixed data.
  for (const { cellOutput, data } of resolvedInputs) {
    parts.push(cellOutput.toBytes(), u32le(data.length), data);
  }

  // 3. First group witness, split: input_type/output_type BytesOpt slices
  //    (lock deliberately excluded). Group indices are validated above.
  const firstIdx = groupInputIndices[0]!;
  const firstWitnessHex = tx.witnesses[firstIdx]!;
  let firstWitness: WitnessArgs;
  try {
    firstWitness = WitnessArgsCodec.fromBytes(bytesFrom(firstWitnessHex));
  } catch (err) {
    throw new Error(
      `buildCighashAllStream: witness ${firstIdx} does not parse as a WitnessArgs molecule`,
      { cause: err },
    );
  }
  const inputTypeSlice = bytesOptSlice(firstWitness.inputType);
  parts.push(u32le(inputTypeSlice.length), inputTypeSlice);
  const outputTypeSlice = bytesOptSlice(firstWitness.outputType);
  parts.push(u32le(outputTypeSlice.length), outputTypeSlice);

  // 4. Remaining group-input witnesses (skip the first), in full.
  for (const idx of groupInputIndices.slice(1)) {
    const witnessBytes = bytesFrom(tx.witnesses[idx]!);
    parts.push(u32le(witnessBytes.length), witnessBytes);
  }

  // 5. Witnesses with no matching input cell, in full.
  for (let i = inputCount; i < witnessCount; i++) {
    const witnessBytes = bytesFrom(tx.witnesses[i]!);
    parts.push(u32le(witnessBytes.length), witnessBytes);
  }

  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Placeholder WitnessArgs with a 5262-zero-byte lock. The placeholder content
 * is irrelevant to the CighashAll stream (the lock field is excluded), but its
 * length affects fee sizing, so reserve the full witness-lock length.
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Transaction-building flow.
 */
export function buildPlaceholderWitness(): WitnessArgs {
  return WitnessArgsCodec.from({
    lock: hexFrom(new Uint8Array(MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN)),
  });
}

/**
 * Copy a WitnessArgs with its lock replaced by the signed witness lock
 * ([0x7B, pubkey, sig] from mldsaV2WitnessLock) — the splice step before
 * broadcast. inputType/outputType are preserved.
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Transaction-building flow.
 */
export function withSignatureLock(witness: WitnessArgs, lockBytes: Uint8Array): WitnessArgs {
  return WitnessArgsCodec.from({
    lock: hexFrom(lockBytes),
    inputType: witness.inputType ?? null,
    outputType: witness.outputType ?? null,
  });
}
