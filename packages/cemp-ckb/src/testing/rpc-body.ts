/**
 * Test-only helper: recompute the signed transaction hash from a captured
 * `send_transaction` RPC body (snake_case wire shape) by round-tripping it
 * through CCC. Fake transports use it to answer `send_transaction` with the
 * exact hash the real pipeline computed locally.
 *
 * Not exported from the package index — test-only.
 */

import { Transaction, numFrom } from "@ckb-ccc/core";

type AnyRec = Record<string, unknown>;

/** The transaction hash the node would accept for this wire body. */
export function hashFromRpcBody(body: AnyRec): string {
  const tx = Transaction.from({
    version: numFrom(body.version as string),
    cellDeps: (body.cell_deps as AnyRec[]).map((dep) => {
      const outPoint = dep.out_point as AnyRec;
      return {
        outPoint: { txHash: outPoint.tx_hash as string, index: numFrom(outPoint.index as string) },
        depType: dep.dep_type as "code" | "depGroup",
      };
    }),
    headerDeps: body.header_deps as string[],
    inputs: (body.inputs as AnyRec[]).map((input) => {
      const previous = input.previous_output as AnyRec;
      return {
        previousOutput: {
          txHash: previous.tx_hash as string,
          index: numFrom(previous.index as string),
        },
        since: numFrom(input.since as string),
      };
    }),
    outputs: (body.outputs as AnyRec[]).map((output) => {
      const lock = output.lock as AnyRec;
      const type = output.type as AnyRec | null;
      return {
        capacity: numFrom(output.capacity as string),
        lock: {
          codeHash: lock.code_hash as string,
          hashType: lock.hash_type as "type",
          args: lock.args as string,
        },
        type:
          type === null
            ? null
            : {
                codeHash: type.code_hash as string,
                hashType: type.hash_type as "type",
                args: type.args as string,
              },
      };
    }),
    outputsData: body.outputs_data as string[],
    witnesses: body.witnesses as string[],
  });
  return tx.hash();
}
