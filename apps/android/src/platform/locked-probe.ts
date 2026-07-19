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
  const page = await findMessageCells(
    client,
    { codeHash: cempType.codeHash, hashType: cempType.hashType },
    bytesFrom(`0x${tagHex}`),
  );
  return page.cells.map((cell) => `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`);
}
