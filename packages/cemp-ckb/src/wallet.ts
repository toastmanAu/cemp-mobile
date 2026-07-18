import { Address, Script, fixedPointFrom } from "@ckb-ccc/core";
import type { Client as CccClient, Script as CccScript } from "@ckb-ccc/core";
import { CempCkbError } from "./client.js";
import type { CkbIndexerProvider, CkbRpcProvider, TransactionPage } from "./providers.js";
import type { Cell, Hash, Script as CempScript } from "./types.js";
import { MESSAGE_TYPE_ARGS } from "./builders.js";

/**
 * Wallet basics: address helpers, cell collection by lock, balance
 * categories, transfer history, message-cell capacity planning and faucet
 * instructions. Read-only except where noted — nothing here broadcasts.
 */

/* ── addresses (Phase 4 task 2) ─────────────────────────────────────────── */

/** bech32(m) address of a lock script on this client's network. */
export function addressFromLockScript(lock: CccScript, client: CccClient): string {
  return Address.fromScript(lock, client).toString();
}

/** Parse a bech32(m) address back to its lock script (validated by CCC). */
export async function lockFromAddress(address: string, client: CccClient): Promise<CccScript> {
  const address_ = await Address.fromString(address, client);
  return address_.script;
}

/* ── cell collection + balance categories (Phase 4 tasks 3, 7) ─────────── */

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

/* ── balance categories (spec §5.5; Phase 4 task 7) ─────────────────────── */

export interface BalanceCategories {
  /** Every live cell of the lock. */
  readonly totalShannon: bigint;
  /** Cells NOT bound in CEMP protocol scripts — freely spendable. */
  readonly availableShannon: bigint;
  /** Cells bound in CEMP protocol scripts (message/transport cells). */
  readonly reservedShannon: bigint;
  /** Protocol cells reclaimable by this wallet right now (sender-owned). */
  readonly reclaimableShannon: bigint;
  readonly cellCount: number;
  readonly protocolCellCount: number;
}

/**
 * Chain-derived balance categories (spec §5.5). `available` = total minus
 * cells carrying the CEMP message type; those are all "reserved" for the
 * protocol, and the sender-owned ones are reclaimable by construction
 * (rule 9). The DB's per-state refinement (reclaim_queued vs pending) is
 * layered on top by the app — this is the authoritative chain view.
 */
export async function balanceCategories(
  indexer: CkbIndexerProvider,
  lockScript: CempScript,
  cempMessageTypeScript: { codeHash: string; hashType: CempScript["hashType"] },
): Promise<BalanceCategories> {
  const all = await collectCells(indexer, lockScript);
  const typeCodeHash = cempMessageTypeScript.codeHash.toLowerCase();
  const typeHashType = cempMessageTypeScript.hashType;
  let total = 0n;
  let reserved = 0n;
  let protocolCellCount = 0;
  for (const cell of all) {
    const capacity = BigInt(cell.output.capacity);
    total += capacity;
    const type = cell.output.type;
    if (
      type !== null &&
      type.codeHash.toLowerCase() === typeCodeHash &&
      type.hashType === typeHashType
    ) {
      reserved += capacity;
      protocolCellCount += 1;
    }
  }
  return {
    totalShannon: total,
    availableShannon: total - reserved,
    reservedShannon: reserved,
    reclaimableShannon: reserved, // all protocol cells here are sender-owned (rule 9)
    cellCount: all.length,
    protocolCellCount,
  };
}

/* ── transfer history (Phase 4 task 6) ──────────────────────────────────── */

export interface TransferRecord {
  readonly txHash: Hash;
  /** Net capacity delta FOR this lock (positive = received). */
  readonly deltaShannon: bigint;
  readonly direction: "received" | "sent" | "self";
  readonly blockNumber: string | null;
}

export interface TransferHistoryPage {
  readonly records: TransferRecord[];
  readonly lastCursor: string;
}

/**
 * Incoming/outgoing transfer history for a lock, newest first. For each
 * indexer-reported transaction the net capacity delta of THIS lock is
 * computed: outputs paying the lock minus inputs spending it (input cells
 * are resolved through their source transactions — get_live_cell cannot
 * see spent cells).
 */
export async function transferHistory(
  provider: CkbIndexerProvider & CkbRpcProvider,
  lockScript: CempScript,
  options: { cursor?: string; limit?: number } = {},
): Promise<TransferHistoryPage> {
  const page: TransactionPage = await provider.findTransactions({
    script: lockScript,
    scriptType: "lock",
    argsSearchMode: "exact",
    order: "desc",
    limit: options.limit ?? 20,
    ...(options.cursor !== undefined ? { after: options.cursor } : {}),
  });
  const records: TransferRecord[] = [];
  for (const entry of page.transactions) {
    const delta = await lockDelta(provider, entry.txHash, lockScript);
    records.push({
      txHash: entry.txHash,
      deltaShannon: delta,
      direction: delta > 0n ? "received" : delta < 0n ? "sent" : "self",
      blockNumber: entry.blockNumber,
    });
  }
  return { records, lastCursor: page.lastCursor };
}

function lockEquals(a: CempScript, b: CempScript): boolean {
  return (
    a.codeHash.toLowerCase() === b.codeHash.toLowerCase() &&
    a.hashType === b.hashType &&
    a.args.toLowerCase() === b.args.toLowerCase()
  );
}

/**
 * Net capacity delta of `lockScript` in transaction `txHash`:
 * outputs paying the lock minus capacities of the lock's cells it spends
 * (resolved one level back through the inputs' source transactions).
 */
async function lockDelta(
  provider: CkbRpcProvider,
  txHash: Hash,
  lockScript: CempScript,
): Promise<bigint> {
  const body = await provider.getTransactionBody(txHash);
  if (body === null) {
    throw new CempCkbError("transferHistory", `node does not know transaction ${txHash}`);
  }
  let delta = 0n;
  for (const output of body.outputs) {
    if (lockEquals(output.lock, lockScript)) {
      delta += BigInt(output.capacity);
    }
  }
  for (const input of body.inputs) {
    const source = await provider.getTransactionBody(input.previousOutput.txHash);
    if (source === null) {
      throw new CempCkbError(
        "transferHistory",
        `node does not know source transaction ${input.previousOutput.txHash}`,
      );
    }
    const spent = source.outputs[Number(BigInt(input.previousOutput.index))];
    if (spent !== undefined && lockEquals(spent.lock, lockScript)) {
      delta -= BigInt(spent.capacity);
    }
  }
  return delta;
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
