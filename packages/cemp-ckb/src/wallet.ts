import { Script, fixedPointFrom } from "@ckb-ccc/core";
import type { Script as CccScript } from "@ckb-ccc/core";
import { CempCkbError } from "./client.js";
import type { CkbIndexerProvider } from "./providers.js";
import type { Cell, Script as CempScript } from "./types.js";
import { MESSAGE_TYPE_ARGS } from "./builders.js";

/**
 * Wallet basics for the headless reference client: cell collection by lock,
 * balance summaries, message-cell capacity planning and faucet instructions.
 * Read-only; nothing here builds or broadcasts transactions.
 */

const COLLECT_PAGE_LIMIT = 64;

/**
 * All live cells of a lock script, paging the indexer to exhaustion
 * (idempotent, rule 5). Exact-args match: the wallet lock args are known
 * precisely. Data is fetched along the way because the caller usually needs
 * it for resolution during signing.
 */
export async function collectCells(
  indexer: CkbIndexerProvider,
  lockScript: CempScript,
): Promise<Cell[]> {
  const cells: Cell[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await indexer.findCells({
      script: lockScript,
      scriptType: "lock",
      argsSearchMode: "exact",
      order: "asc",
      limit: COLLECT_PAGE_LIMIT,
      ...(cursor !== undefined ? { after: cursor } : {}),
    });
    cells.push(...page.cells);
    if (page.cells.length < COLLECT_PAGE_LIMIT) {
      return cells;
    }
    cursor = page.lastCursor;
  }
}

export interface BalanceSummary {
  /** Total capacity in shannons. */
  total: bigint;
  cellCount: number;
  /** Largest single cell capacity in shannons (0n when empty). */
  largestCell: bigint;
}

/** Sum a cell list into a balance summary. Capacities must be hex quantities. */
export function balanceSummary(cells: readonly Cell[]): BalanceSummary {
  let total = 0n;
  let largestCell = 0n;
  for (const cell of cells) {
    let capacity: bigint;
    try {
      capacity = BigInt(cell.output.capacity);
    } catch (err) {
      throw new CempCkbError(
        "balanceSummary",
        `unparseable capacity ${JSON.stringify(cell.output.capacity)}`,
        { cause: err },
      );
    }
    total += capacity;
    if (capacity > largestCell) {
      largestCell = capacity;
    }
  }
  return { total, cellCount: cells.length, largestCell };
}

/**
 * Occupied-size capacity (in shannons) of a message cell holding
 * `envelopeByteLength` bytes of envelope data under the given sender lock
 * and CEMP message type script (spec §6: 81-byte type args). This is the
 * exact occupied minimum — builders add their own margin on top.
 */
export function messageCellCapacity(
  envelopeByteLength: number,
  senderLock: CempScript | CccScript,
  cempMessageType: { codeHash: string; hashType: CempScript["hashType"] },
): bigint {
  if (!Number.isSafeInteger(envelopeByteLength) || envelopeByteLength < 0) {
    throw new CempCkbError(
      "messageCellCapacity",
      `envelope length ${envelopeByteLength} is not a non-negative safe integer`,
    );
  }
  const lock = Script.from(senderLock);
  const type = Script.from({
    codeHash: cempMessageType.codeHash,
    hashType: cempMessageType.hashType,
    args: `0x${"00".repeat(MESSAGE_TYPE_ARGS.totalBytes)}`,
  });
  const occupiedBytes = 8 + lock.occupiedSize + type.occupiedSize + envelopeByteLength;
  return fixedPointFrom(occupiedBytes);
}

/**
 * Human-readable testnet faucet instructions (spec: testnet faucet
 * instructions are shown, never automated, in this layer).
 */
export function faucetClaimInstructions(address: string): string {
  return [
    "Testnet CKB is needed to fund this wallet.",
    "1. Open https://faucet.nervos.org in a browser.",
    `2. Paste this CKB testnet address into the address field: ${address}`,
    '3. Keep the network set to "Testnet", complete the captcha and press "Claim".',
    "4. Wait for the claim transaction to confirm, then re-check the wallet balance.",
  ].join("\n");
}
