import { bytesFrom, hexFrom } from "@ckb-ccc/core";
import { codec } from "@cemp/core";
import { CempCkbError } from "./client.js";
import type { CkbIndexerProvider, CkbRpcProvider, CellPage } from "./providers.js";
import type { HashType, OutPoint } from "./types.js";
import { MESSAGE_TYPE_ARGS } from "./builders.js";

/**
 * Incoming-message discovery (spec §6.1, §12 sync).
 *
 * Message cells carry the 81-byte type args
 * `version(0x01) ‖ route_tag(32) ‖ conversation_tag(16) ‖ message_nonce(16)`,
 * so a recipient finds its cells with a type-args PREFIX search over
 * `0x01 ‖ route_tag` (33 bytes). The prefix query itself is issued by the
 * indexer provider (`CempClient.findCells` with `argsSearchMode: "prefix"`,
 * which emits `script_search_mode: "prefix"` — the only spelling the public
 * testnet indexer honors, per the 2026-07-17 live probe; the legacy
 * `args_search_mode` field is silently ignored there).
 *
 * Every returned cell is re-checked against the prefix here even though the
 * indexer already filtered: indexer output is hostile input (AGENTS.md
 * rule 4), and a cell that does not match the prefix can never be a message
 * for this recipient. Cells whose data exceeds the §11 envelope limit are
 * dropped for the same reason (they are definitionally not v1 messages).
 */

/**
 * The 33-byte discovery prefix: version byte 0x01 ‖ route_tag.
 */
export function buildRouteTagPrefix(routeTag: Uint8Array): Uint8Array {
  if (routeTag.length !== MESSAGE_TYPE_ARGS.routeTagBytes) {
    throw new CempCkbError(
      "buildRouteTagPrefix",
      `route_tag is ${routeTag.length} bytes, expected ${MESSAGE_TYPE_ARGS.routeTagBytes}`,
    );
  }
  const out = new Uint8Array(1 + MESSAGE_TYPE_ARGS.routeTagBytes);
  out[0] = MESSAGE_TYPE_ARGS.version;
  out.set(routeTag, 1);
  return out;
}

export interface MessageCellQuery {
  codeHash: string;
  hashType: HashType;
}

/**
 * One page of message cells for a route tag. Pass `lastCursor` back as
 * `cursor` to continue (spec §12 sync cursors; every call is idempotent,
 * rule 5). Cells failing the post-checks described in the module header are
 * dropped silently — they are transport noise, not errors (spec §12.6).
 */
export async function findMessageCells(
  indexer: CkbIndexerProvider,
  cempMessageTypeScript: MessageCellQuery,
  routeTag: Uint8Array,
  cursor?: string,
): Promise<CellPage> {
  const prefix = buildRouteTagPrefix(routeTag);
  const prefixHex = hexFrom(prefix);
  const page = await indexer.findCells({
    script: {
      codeHash: cempMessageTypeScript.codeHash,
      hashType: cempMessageTypeScript.hashType,
      args: prefixHex,
    },
    scriptType: "type",
    argsSearchMode: "prefix",
    order: "asc",
    ...(cursor !== undefined ? { after: cursor } : {}),
  });
  const cells = page.cells.filter((cell) => {
    const type = cell.output.type;
    if (type === null) {
      return false;
    }
    const args = bytesFrom(type.args);
    if (args.length !== MESSAGE_TYPE_ARGS.totalBytes) {
      return false;
    }
    for (let i = 0; i < prefix.length; i++) {
      if (args[i] !== prefix[i]) {
        return false;
      }
    }
    return bytesFrom(cell.data).length <= codec.V1_LIMITS.maxEnvelopeBytes;
  });
  return { cells, lastCursor: page.lastCursor };
}

// ── watched outpoint (spec §7.4) ────────────────────────────────────────────

export interface WatchOutpointOptions {
  /** Poll interval in ms (default 5 s). */
  pollIntervalMs?: number;
  /** Give up after this many ms (default 10 min). */
  timeoutMs?: number;
}

export type WatchOutpointResult = "spent" | "timeout";

/**
 * Poll `get_live_cell` until the out point is no longer live ("spent" also
 * covers "unknown": from this client's perspective the cell is gone either
 * way) or the timeout elapses. Used by the reclaim-eligibility watcher
 * (spec §7.4). Idempotent and side-effect free.
 */
export async function watchOutpointUntilSpent(
  rpc: Pick<CkbRpcProvider, "getLiveCell">,
  outPoint: OutPoint,
  options: WatchOutpointOptions = {},
): Promise<WatchOutpointResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (pollIntervalMs <= 0 || timeoutMs <= 0) {
    throw new CempCkbError(
      "watchOutpointUntilSpent",
      `poll interval and timeout must be positive (got ${pollIntervalMs} ms / ${timeoutMs} ms)`,
    );
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await rpc.getLiveCell(outPoint);
    if (status.status !== "live") {
      return "spent";
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return "timeout";
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
