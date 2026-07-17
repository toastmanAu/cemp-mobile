/**
 * CCC → wire conversion (the outbound counterpart of client.ts's
 * `transactionToRpc`). Produces the JSON-shaped {@link Transaction} that
 * `CempClient.sendTransaction` validates and broadcasts — and that the
 * pre-broadcast journal persists (rule 6: the journaled body is exactly what
 * hits the wire).
 */

import type { NumLike, Script as CccScript, Transaction as CccTransaction } from "@ckb-ccc/core";
import { hexFrom, numFrom } from "@ckb-ccc/core";
import type { HashType, Script, Transaction } from "./types.js";

function numToHex(value: NumLike): string {
  return `0x${numFrom(value).toString(16)}`;
}

function scriptToWire(script: CccScript): Script {
  return {
    codeHash: script.codeHash,
    hashType: script.hashType as HashType,
    args: script.args,
  };
}

/** Serialize a CCC transaction to the wire/journal shape. */
export function cccTransactionToWire(tx: CccTransaction): Transaction {
  return {
    version: numToHex(tx.version),
    cellDeps: tx.cellDeps.map((dep) => ({
      outPoint: { txHash: dep.outPoint.txHash, index: numToHex(dep.outPoint.index) },
      depType: dep.depType,
    })),
    headerDeps: tx.headerDeps.map((hash) => hash),
    inputs: tx.inputs.map((input) => ({
      previousOutput: {
        txHash: input.previousOutput.txHash,
        index: numToHex(input.previousOutput.index),
      },
      since: numToHex(input.since),
    })),
    outputs: tx.outputs.map((output) => ({
      capacity: numToHex(output.capacity),
      lock: scriptToWire(output.lock),
      type: output.type === undefined ? null : scriptToWire(output.type),
    })),
    outputsData: tx.outputsData.map((data) => hexFrom(data)),
    witnesses: tx.witnesses.map((witness) => hexFrom(witness)),
  };
}
