import { hexFrom, numToHex } from "@ckb-ccc/core";
import type { Script as CccScript, Transaction as CccTransaction } from "@ckb-ccc/core";
import type { Script, Transaction } from "@cemp/ckb";

/**
 * Serialize a CCC transaction into the JSON-shaped `Transaction` of
 * `@cemp/ckb` (`types.ts`) — the shape stored in the pre-broadcast journal
 * (rule 6) and accepted by `CempClient.sendTransaction`, which re-validates
 * every field before emitting the `send_transaction` wire body.
 */

function scriptToWire(script: CccScript): Script {
  return { codeHash: script.codeHash, hashType: script.hashType, args: script.args };
}

export function cccTxToWire(tx: CccTransaction): Transaction {
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
    outputsData: tx.outputsData.map((data) => data),
    witnesses: tx.witnesses.map((witness) => hexFrom(witness)),
  };
}
