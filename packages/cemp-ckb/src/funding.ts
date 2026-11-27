/**
 * Pre-decryption rate-limit key for a chain-delivered message cell (ADR 0007
 * resolved question 3): the lock hash of the FIRST INPUT of the transaction
 * that created the cell — the wallet that paid for it. Throws on any RPC
 * failure or inconsistent answer; the caller defers the cell rather than
 * guessing a key.
 */

import { Script } from "@ckb-ccc/core";
import { CempCkbError, type CempClient } from "./client.js";

export async function fundingLockHash(
  client: Pick<CempClient, "getTransactionBody">,
  txHash: string,
): Promise<string> {
  const tx = await client.getTransactionBody(txHash);
  const first = tx?.inputs[0];
  if (first === undefined) {
    throw new CempCkbError("fundingLockHash", "creating transaction unknown or has no inputs");
  }
  const source = await client.getTransactionBody(first.previousOutput.txHash);
  const output = source?.outputs[Number(BigInt(first.previousOutput.index))];
  if (output === undefined) {
    throw new CempCkbError("fundingLockHash", "first input's source output is unknown");
  }
  return Script.from(output.lock).hash();
}
