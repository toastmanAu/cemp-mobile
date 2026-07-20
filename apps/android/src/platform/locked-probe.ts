/**
 * Chain query for the locked-mode probe (Phase 9 design D1).
 *
 * Deliberately standalone: on a cold start there is no AppContainer, and
 * MessagingService cannot be built because constructing it derives identity
 * keys from an unlocked vault. A route-tag lookup needs neither — only a
 * transport and the pinned testnet endpoints — so this module builds its own
 * client and never touches the vault or the database.
 */

import {
  CempClient,
  fetchJsonRpcTransport,
  findMessageCells,
  type JsonRpcTransport,
} from "@cemp/ckb";
import { CKB_TESTNET } from "@cemp/core";
import { bytesFrom } from "@ckb-ccc/core";

const RPC_TIMEOUT_MS = 15_000;

// Diagnostics only — counts, never a tag, cursor, or outpoint. See the
// SECURITY note in background-sync.ts, which this module's caller carries.
const LOG_TAG = "[CempSync]";

/** Outpoints (`txHash:index`) currently on-chain for one hex route tag. */
export async function outpointsForTag(
  tagHex: string,
  transport: JsonRpcTransport = fetchJsonRpcTransport(RPC_TIMEOUT_MS),
): Promise<string[]> {
  const cempType = CKB_TESTNET.deployments.cempMessageType;
  if (cempType === null) {
    console.log(`${LOG_TAG} locked probe: no cempMessageType deployment configured`);
    return [];
  }
  const client = new CempClient({ transport, endpoints: CKB_TESTNET.endpoints[0]! });
  const routeTag = bytesFrom(`0x${tagHex}`);
  const messageType = { codeHash: cempType.codeHash, hashType: cempType.hashType };

  // FULL scan, exactly as the unlocked discovery worker does
  // (packages/cemp-sync/src/workers.ts runIncomingDiscovery). Reading only the
  // first page would silently go dark: `findMessageCells` pages 64 cells at a
  // time in `asc` order, so once a route tag holds 64+ cells every new arrival
  // sorts past page one and is never seen — while the tag still counts as
  // having answered, so the caller overwrites `lastSeen` with the stale page
  // and reports success. The cursor below paginates WITHIN this one scan only
  // and is never persisted: an exhausted indexer scan returns a terminal "0x"
  // cursor, and `get_cells(after: "0x")` then returns nothing forever, even
  // once new cells arrive.
  const outpoints: string[] = [];
  let cursor: string | undefined = undefined;
  let page = 0;
  console.log(`${LOG_TAG} locked probe: chain query starting`);
  for (;;) {
    page += 1;
    let result: Awaited<ReturnType<typeof findMessageCells>>;
    try {
      result = await findMessageCells(client, messageType, routeTag, cursor);
    } catch (error) {
      // The error CLASS only, never its message: `findMessageCells` raises
      // `CempCkbError`, whose message embeds an 80-character `preview()` of
      // raw RPC response data — long enough to carry a 66-character tx hash
      // from the user's own inbox into world-readable logcat.
      console.warn(
        `${LOG_TAG} locked probe: chain query page ${page} failed — ` +
          (error instanceof Error ? error.name : typeof error),
      );
      throw error;
    }
    console.log(
      `${LOG_TAG} locked probe: chain query page ${page} returned ${result.cells.length} cell(s)`,
    );
    for (const cell of result.cells) {
      outpoints.push(`${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`);
    }
    if (result.cells.length === 0 || result.lastCursor === "0x" || result.lastCursor === "") {
      break;
    }
    cursor = result.lastCursor;
  }
  console.log(`${LOG_TAG} locked probe: chain query finished, ${outpoints.length} outpoint(s)`);
  return outpoints;
}
