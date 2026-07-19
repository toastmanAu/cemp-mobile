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

/** Outpoints (`txHash:index`) currently on-chain for one hex route tag. */
export async function outpointsForTag(
  tagHex: string,
  transport: JsonRpcTransport = fetchJsonRpcTransport(RPC_TIMEOUT_MS),
): Promise<string[]> {
  const cempType = CKB_TESTNET.deployments.cempMessageType;
  if (cempType === null) {
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
  for (;;) {
    const page = await findMessageCells(client, messageType, routeTag, cursor);
    for (const cell of page.cells) {
      outpoints.push(`${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`);
    }
    if (page.cells.length === 0 || page.lastCursor === "0x" || page.lastCursor === "") {
      break;
    }
    cursor = page.lastCursor;
  }
  return outpoints;
}
