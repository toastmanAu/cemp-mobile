import { ClientPublicTestnet } from "@ckb-ccc/core";
import type { Client as CccClient } from "@ckb-ccc/core";
import { CKB_TESTNET } from "@cemp/core";
import type { NetworkConfig, NetworkEndpoints } from "@cemp/core";
import type {
  CkbIndexerProvider,
  CkbRpcProvider,
  CellQuery,
  CellPage,
  TransactionPage,
} from "./providers.js";
import type {
  Cell,
  Hash,
  Header,
  LiveCellStatus,
  OutPoint,
  Script,
  Transaction,
  TransactionStatus,
} from "./types.js";

/**
 * Thin CEMP client over the public CKB testnet (grounding:
 * docs/grounding/reference-projects.md §3 — RPC https://testnet.ckb.dev/,
 * indexer https://testnet.ckbapp.dev/; both serve node and indexer methods on
 * one URL, verified live 2026-07-17).
 *
 * Two halves:
 *
 *  1. `ccc` — a `ccc.ClientPublicTestnet` instance used for transaction
 *     building and coin selection (CCC 1.12.5, pinned per ADR 0004).
 *  2. Validated read methods implementing `CkbIndexerProvider` and the
 *     read-only part of `CkbRpcProvider`. These talk JSON-RPC directly so
 *     that EVERY response shape is validated here before use (AGENTS.md
 *     rule 4 — RPC and indexer responses are hostile input). CCC's own
 *     transformers are bypassed for these reads because they silently
 *     default missing fields (e.g. `output_data ?? "0x"`) and drop the
 *     `status` field of `get_live_cell` (a CCC 1.12.5 quirk: dead and
 *     unknown cells are indistinguishable through `client.getCellLive`).
 *
 * Prefix search: CCC 1.12.5 CAN express it (`ClientIndexerSearchKeyLike.
 * scriptSearchMode`), and the live probe shows the public testnet indexer
 * honors `script_search_mode` (`exact`/`prefix`; `partial` is rejected with
 * "please use the CKB rich-indexer"). The legacy `args_search_mode` field is
 * silently IGNORED by the indexer. This client therefore emits
 * `script_search_mode` explicitly on every `get_cells` call — no
 * `clientSearchKeyRangeFrom` range-transform fallback is needed.
 *
 * `sendTransaction` is the single broadcast entry point. It takes the
 * JSON-shaped `Transaction` (see `types.ts`) — NOT a CCC object — so the
 * caller must serialize before calling, which is exactly the moment the
 * pre-broadcast journal entry must be written (AGENTS.md rule 6: journal the
 * unsigned transaction BEFORE any `send_transaction` call). The wire body is
 * re-validated field by field before it leaves the process (rule 4 cuts both
 * ways: never emit malformed transactions either). It always sends with
 * `outputs_validator: "passthrough"` by default: CEMP outputs carry the
 * ML-DSA-65 v2 lock and the CEMP message type script, which are not in the
 * node's well-known script list, so the default validator would reject them.
 */

/** All shape/transport failures of this module are reported as this type. */
export class CempCkbError extends Error {
  readonly context: string;

  constructor(context: string, detail: string, options?: { cause?: unknown }) {
    super(`${context}: ${detail}`, options);
    this.name = "CempCkbError";
    this.context = context;
  }
}

// ── shape guards (rule 4) ───────────────────────────────────────────────────

/** Clip hostile values before embedding them in error messages. */
function preview(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function asRecord(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CempCkbError(ctx, `expected an object, got ${preview(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, ctx: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CempCkbError(ctx, `expected an array, got ${preview(value)}`);
  }
  return value;
}

function asString(value: unknown, ctx: string): string {
  if (typeof value !== "string") {
    throw new CempCkbError(ctx, `expected a string, got ${preview(value)}`);
  }
  return value;
}

/** 0x-prefixed even-length hex bytes, as used for args/data/hashes. */
function asHex(value: unknown, ctx: string): string {
  const hex = asString(value, ctx);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new CempCkbError(ctx, `expected 0x-prefixed even-length hex, got ${preview(hex)}`);
  }
  return hex;
}

/** 0x-prefixed hex QUANTITY (CKB-RPC convention: any digit count, e.g. "0x0"). */
function asQuantityHex(value: unknown, ctx: string): string {
  const hex = asString(value, ctx);
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new CempCkbError(ctx, `expected a 0x-prefixed hex quantity, got ${preview(hex)}`);
  }
  return hex;
}

/** 32-byte hash, 0x-prefixed hex. */
function asHash(value: unknown, ctx: string): Hash {
  const hex = asHex(value, ctx);
  if (hex.length !== 66) {
    throw new CempCkbError(ctx, `expected a 32-byte hash, got ${preview(hex)}`);
  }
  return hex;
}

const U64_MAX = 0xff_ff_ff_ff_ff_ff_ffn;

/** 0x-prefixed hex uint64 within range; returns the canonical (parsed) bigint too. */
function asU64Hex(value: unknown, ctx: string): { hex: string; num: bigint } {
  const hex = asQuantityHex(value, ctx);
  let num: bigint;
  try {
    num = BigInt(hex);
  } catch {
    throw new CempCkbError(ctx, `unparseable hex quantity ${preview(hex)}`);
  }
  if (num > U64_MAX) {
    throw new CempCkbError(ctx, `hex quantity ${preview(hex)} exceeds uint64`);
  }
  return { hex, num };
}

function asHashType(value: unknown, ctx: string): Script["hashType"] {
  const ht = asString(value, ctx);
  if (ht !== "type" && ht !== "data" && ht !== "data1" && ht !== "data2") {
    throw new CempCkbError(ctx, `unknown hash_type ${preview(ht)}`);
  }
  return ht;
}

function parseScript(value: unknown, ctx: string): Script {
  const rec = asRecord(value, ctx);
  return {
    codeHash: asHash(rec.code_hash, `${ctx}.code_hash`),
    hashType: asHashType(rec.hash_type, `${ctx}.hash_type`),
    args: asHex(rec.args, `${ctx}.args`),
  };
}

function parseOutPoint(value: unknown, ctx: string): OutPoint {
  const rec = asRecord(value, ctx);
  const index = asU64Hex(rec.index, `${ctx}.index`);
  if (index.num > 0xff_ff_ff_ffn) {
    throw new CempCkbError(`${ctx}.index`, `out-point index ${preview(rec.index)} exceeds uint32`);
  }
  return { txHash: asHash(rec.tx_hash, `${ctx}.tx_hash`), index: index.hex };
}

function parseCellOutput(value: unknown, ctx: string): Cell["output"] {
  const rec = asRecord(value, ctx);
  const capacity = asU64Hex(rec.capacity, `${ctx}.capacity`);
  let type: Script | null = null;
  if (rec.type !== null && rec.type !== undefined) {
    type = parseScript(rec.type, `${ctx}.type`);
  }
  return {
    capacity: capacity.hex,
    lock: parseScript(rec.lock, `${ctx}.lock`),
    type,
  };
}

/**
 * Parse one cell object as returned by indexer `get_cells`
 * (`{out_point, output, output_data, block_number}`) or by `get_live_cell`
 * (`{output, data: {content}}`, no out point / block number — pass the
 * request's out point and no block number).
 */
function parseIndexerCell(value: unknown, ctx: string): Cell {
  const rec = asRecord(value, ctx);
  const data =
    rec.output_data === null || rec.output_data === undefined
      ? "0x"
      : asHex(rec.output_data, `${ctx}.output_data`);
  return {
    outPoint: parseOutPoint(rec.out_point, `${ctx}.out_point`),
    output: parseCellOutput(rec.output, `${ctx}.output`),
    data,
    blockNumber: asU64Hex(rec.block_number, `${ctx}.block_number`).hex,
  };
}

// ── response parsers (exported for tests and for discovery pre-filtering) ──

/** Validate a `get_cells` result body (`{last_cursor, objects}`). */
export function parseCellsPage(json: unknown): CellPage {
  const rec = asRecord(json, "get_cells result");
  const lastCursor = asString(rec.last_cursor, "get_cells result.last_cursor");
  const objects = asArray(rec.objects, "get_cells result.objects");
  return {
    lastCursor,
    cells: objects.map((cell, i) => parseIndexerCell(cell, `get_cells objects[${i}]`)),
  };
}

/** Validate a `get_transactions` result body (ungrouped). */
export function parseTransactionsPage(json: unknown): TransactionPage {
  const rec = asRecord(json, "get_transactions result");
  const lastCursor = asString(rec.last_cursor, "get_transactions result.last_cursor");
  const objects = asArray(rec.objects, "get_transactions result.objects");
  return {
    lastCursor,
    transactions: objects.map((value, i) => {
      const ctx = `get_transactions objects[${i}]`;
      const tx = asRecord(value, ctx);
      const ioType = asString(tx.io_type, `${ctx}.io_type`);
      if (ioType !== "input" && ioType !== "output") {
        throw new CempCkbError(
          `${ctx}.io_type`,
          `expected "input" or "output", got ${preview(ioType)}`,
        );
      }
      return {
        txHash: asHash(tx.tx_hash, `${ctx}.tx_hash`),
        blockNumber: asU64Hex(tx.block_number, `${ctx}.block_number`).hex,
        txIndex: asU64Hex(tx.tx_index, `${ctx}.tx_index`).hex,
        ioType,
        ioIndex: asU64Hex(tx.io_index, `${ctx}.io_index`).hex,
      };
    }),
  };
}

/** Validate a `get_tip_header` result body. */
export function parseTipHeader(json: unknown): Header {
  const rec = asRecord(json, "get_tip_header result");
  return {
    number: asU64Hex(rec.number, "get_tip_header result.number").hex,
    epoch: asU64Hex(rec.epoch, "get_tip_header result.epoch").hex,
    timestamp: asU64Hex(rec.timestamp, "get_tip_header result.timestamp").hex,
    hash: asHash(rec.hash, "get_tip_header result.hash"),
  };
}

/**
 * Validate a `get_live_cell` result body (`{cell, status}`). CCC 1.12.5 drops
 * the status field entirely, which is why this read bypasses CCC (see the
 * module header). A `live` status must carry a well-formed cell; `dead` and
 * `unknown` must not.
 */
export function parseLiveCellStatus(json: unknown, outPoint: OutPoint): LiveCellStatus {
  const rec = asRecord(json, "get_live_cell result");
  const status = asString(rec.status, "get_live_cell result.status");
  if (status === "live") {
    const cell = asRecord(rec.cell, "get_live_cell result.cell");
    const dataRec = asRecord(cell.data, "get_live_cell result.cell.data");
    return {
      status: "live",
      cell: {
        outPoint,
        output: parseCellOutput(cell.output, "get_live_cell result.cell.output"),
        data: asHex(dataRec.content, "get_live_cell result.cell.data.content"),
      },
    };
  }
  if (status === "dead" || status === "unknown") {
    return { status, outPoint };
  }
  throw new CempCkbError("get_live_cell result.status", `unknown status ${preview(status)}`);
}

/**
 * `get_transaction` mapped onto our status union. `committed` carries only
 * the block hash: CKB reports no block number here, so the caller resolves
 * it with a `get_header` follow-up before returning a `TransactionStatus`.
 */
export type RawTransactionStatus =
  | { status: "sent" | "pending" | "proposed"; txHash: Hash }
  | { status: "unknown"; txHash: Hash }
  | { status: "rejected"; txHash: Hash; reason?: string }
  | { status: "committed"; txHash: Hash; blockHash: Hash };

/** Validate a `get_transaction` result body (null when the node knows nothing). */
export function parseTransactionStatus(json: unknown, txHash: Hash): RawTransactionStatus {
  if (json === null) {
    return { status: "unknown", txHash };
  }
  const rec = asRecord(json, "get_transaction result");
  const txStatus = asRecord(rec.tx_status, "get_transaction result.tx_status");
  const status = asString(txStatus.status, "get_transaction result.tx_status.status");
  const reason =
    txStatus.reason === null || txStatus.reason === undefined
      ? undefined
      : asString(txStatus.reason, "get_transaction result.tx_status.reason");
  switch (status) {
    case "pending":
    case "proposed":
    case "sent":
      return { status, txHash };
    case "unknown":
      return { status: "unknown", txHash };
    case "rejected":
      return { status: "rejected", txHash, ...(reason !== undefined ? { reason } : {}) };
    case "committed":
      return {
        status: "committed",
        txHash,
        blockHash: asHash(txStatus.block_hash, "get_transaction result.tx_status.block_hash"),
      };
    default:
      throw new CempCkbError(
        "get_transaction result.tx_status.status",
        `unknown status ${preview(status)}`,
      );
  }
}

// ── outgoing transaction serialization (send_transaction) ───────────────────

/**
 * Validate a `get_transaction` result's `transaction` field into the wire
 * {@link Transaction} shape (snake_case RPC → camelCase). Inverse of
 * {@link transactionToRpc}; same strictness (rule 4).
 */
export function parseTransactionBody(json: unknown, ctx: string): Transaction {
  const rec = asRecord(json, ctx);
  const outputs = asArray(rec.outputs, `${ctx}.outputs`).map((output, i) => {
    const outputRec = asRecord(output, `${ctx}.outputs[${i}]`);
    const type = outputRec.type;
    return {
      capacity: asU64Hex(outputRec.capacity, `${ctx}.outputs[${i}].capacity`).hex,
      lock: parseScript(outputRec.lock, `${ctx}.outputs[${i}].lock`),
      type:
        type === null || type === undefined ? null : parseScript(type, `${ctx}.outputs[${i}].type`),
    };
  });
  const outputsData = asArray(rec.outputs_data, `${ctx}.outputs_data`).map((data, i) =>
    asHex(data, `${ctx}.outputs_data[${i}]`),
  );
  if (outputs.length !== outputsData.length) {
    throw new CempCkbError(
      ctx,
      `outputs/outputs_data length mismatch (${outputs.length} != ${outputsData.length})`,
    );
  }
  return {
    version: asU64Hex(rec.version, `${ctx}.version`).hex,
    cellDeps: asArray(rec.cell_deps, `${ctx}.cell_deps`).map((dep, i) => {
      const depRec = asRecord(dep, `${ctx}.cell_deps[${i}]`);
      const outPoint = asRecord(depRec.out_point, `${ctx}.cell_deps[${i}].out_point`);
      const index = asU64Hex(outPoint.index, `${ctx}.cell_deps[${i}].out_point.index`);
      if (index.num > 0xff_ff_ff_ffn) {
        throw new CempCkbError(ctx, `cell dep index exceeds uint32`);
      }
      return {
        outPoint: {
          txHash: asHash(outPoint.tx_hash, `${ctx}.cell_deps[${i}].out_point.tx_hash`),
          index: index.hex,
        },
        depType: parseDepType(depRec.dep_type, `${ctx}.cell_deps[${i}].dep_type`),
      };
    }),
    headerDeps: asArray(rec.header_deps, `${ctx}.header_deps`).map((hash, i) =>
      asHash(hash, `${ctx}.header_deps[${i}]`),
    ),
    inputs: asArray(rec.inputs, `${ctx}.inputs`).map((input, i) => {
      const inputRec = asRecord(input, `${ctx}.inputs[${i}]`);
      const previous = asRecord(inputRec.previous_output, `${ctx}.inputs[${i}].previous_output`);
      const index = asU64Hex(previous.index, `${ctx}.inputs[${i}].previous_output.index`);
      if (index.num > 0xff_ff_ff_ffn) {
        throw new CempCkbError(ctx, `input out-point index exceeds uint32`);
      }
      return {
        previousOutput: {
          txHash: asHash(previous.tx_hash, `${ctx}.inputs[${i}].previous_output.tx_hash`),
          index: index.hex,
        },
        since: asU64Hex(inputRec.since, `${ctx}.inputs[${i}].since`).hex,
      };
    }),
    outputs,
    outputsData,
    witnesses: asArray(rec.witnesses, `${ctx}.witnesses`).map((witness, i) =>
      asHex(witness, `${ctx}.witnesses[${i}]`),
    ),
  };
}

/** `outputs_validator` values accepted by `send_transaction`. */
export type OutputsValidator = "passthrough" | "well_known_scripts_only";

function parseDepType(value: unknown, ctx: string): "code" | "depGroup" {
  const depType = asString(value, ctx);
  if (depType !== "code" && depType !== "depGroup") {
    throw new CempCkbError(ctx, `unknown dep_type ${preview(depType)}`);
  }
  return depType;
}

function u32IndexHex(value: unknown, ctx: string): string {
  const index = asU64Hex(value, ctx);
  if (index.num > 0xff_ff_ff_ffn) {
    throw new CempCkbError(ctx, `out-point index ${preview(value)} exceeds uint32`);
  }
  return index.hex;
}

/** Validate a camelCase {@link Script} (types.ts shape) before re-serializing. */
function parseOutgoingScript(value: unknown, ctx: string): Script {
  const rec = asRecord(value, ctx);
  return {
    codeHash: asHash(rec.codeHash, `${ctx}.codeHash`),
    hashType: asHashType(rec.hashType, `${ctx}.hashType`),
    args: asHex(rec.args, `${ctx}.args`),
  };
}

/**
 * Validate a JSON-shaped {@link Transaction} field by field and emit the exact
 * `send_transaction` wire body (snake_case, 0x-quantities). Anything malformed
 * throws {@link CempCkbError} BEFORE the request leaves the process — the
 * caller signs what it journals, so a shape bug here would otherwise burn a
 * signature on an unbroadcastable transaction.
 */
export function transactionToRpc(tx: Transaction): Record<string, unknown> {
  const rec = asRecord(tx, "transaction");
  const cellDeps = asArray(rec.cellDeps, "transaction.cell_deps").map((dep, i) => {
    const depRec = asRecord(dep, `transaction.cell_deps[${i}]`);
    const outPoint = asRecord(depRec.outPoint, `transaction.cell_deps[${i}].out_point`);
    return {
      out_point: {
        tx_hash: asHash(outPoint.txHash, `transaction.cell_deps[${i}].out_point.tx_hash`),
        index: u32IndexHex(outPoint.index, `transaction.cell_deps[${i}].out_point.index`),
      },
      dep_type: parseDepType(depRec.depType, `transaction.cell_deps[${i}].dep_type`),
    };
  });
  const headerDeps = asArray(rec.headerDeps, "transaction.header_deps").map((hash, i) =>
    asHash(hash, `transaction.header_deps[${i}]`),
  );
  const inputs = asArray(rec.inputs, "transaction.inputs").map((input, i) => {
    const inputRec = asRecord(input, `transaction.inputs[${i}]`);
    const previous = asRecord(inputRec.previousOutput, `transaction.inputs[${i}].previous_output`);
    return {
      previous_output: {
        tx_hash: asHash(previous.txHash, `transaction.inputs[${i}].previous_output.tx_hash`),
        index: u32IndexHex(previous.index, `transaction.inputs[${i}].previous_output.index`),
      },
      since: asU64Hex(inputRec.since, `transaction.inputs[${i}].since`).hex,
    };
  });
  const outputs = asArray(rec.outputs, "transaction.outputs").map((output, i) => {
    const outputRec = asRecord(output, `transaction.outputs[${i}]`);
    const type = outputRec.type;
    return {
      capacity: asU64Hex(outputRec.capacity, `transaction.outputs[${i}].capacity`).hex,
      lock: scriptToRpc(parseOutgoingScript(outputRec.lock, `transaction.outputs[${i}].lock`)),
      type:
        type === null || type === undefined
          ? null
          : scriptToRpc(parseOutgoingScript(type, `transaction.outputs[${i}].type`)),
    };
  });
  const outputsData = asArray(rec.outputsData, "transaction.outputs_data").map((data, i) =>
    asHex(data, `transaction.outputs_data[${i}]`),
  );
  if (outputsData.length !== outputs.length) {
    throw new CempCkbError(
      "transaction",
      `outputs (${outputs.length}) and outputs_data (${outputsData.length}) length mismatch`,
    );
  }
  const witnesses = asArray(rec.witnesses, "transaction.witnesses").map((witness, i) =>
    asHex(witness, `transaction.witnesses[${i}]`),
  );
  return {
    version: asQuantityHex(rec.version, "transaction.version"),
    cell_deps: cellDeps,
    header_deps: headerDeps,
    inputs,
    outputs,
    outputs_data: outputsData,
    witnesses,
  };
}

// ── JSON-RPC transport ──────────────────────────────────────────────────────

/** Minimal JSON-RPC transport seam (injectable for tests/offline). */
export interface JsonRpcTransport {
  call(url: string, method: string, params: unknown[]): Promise<unknown>;
}

/** Default fetch-based transport with a per-request timeout. */
export function fetchJsonRpcTransport(timeoutMs: number): JsonRpcTransport {
  let nextId = 1;
  return {
    async call(url, method, params) {
      let response: Response;
      // AbortController + setTimeout, not AbortSignal.timeout: Hermes (React
      // Native) lacks the static factory, so stay on the portable primitive.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new CempCkbError(
          `${method} ${url}`,
          `request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new CempCkbError(`${method} ${url}`, `HTTP ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        throw new CempCkbError(
          `${method} ${url}`,
          `response is not JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const rec = asRecord(body, `${method} ${url} response`);
      if (rec.error !== undefined && rec.error !== null) {
        const errRec = asRecord(rec.error, `${method} ${url} response.error`);
        const code = typeof errRec.code === "number" ? errRec.code : "?";
        const message = asString(errRec.message, `${method} ${url} response.error.message`);
        throw new CempCkbError(`${method} ${url}`, `RPC error ${code}: ${message}`);
      }
      if (!("result" in rec)) {
        throw new CempCkbError(`${method} ${url} response`, `missing "result" field`);
      }
      return rec.result;
    },
  };
}

// ── client ──────────────────────────────────────────────────────────────────

export interface CempClientOptions {
  /** Network configuration; defaults to {@link CKB_TESTNET}. */
  network?: NetworkConfig;
  /** Endpoint override; defaults to the network's first endpoint pair. */
  endpoints?: NetworkEndpoints;
  /** JSON-RPC transport override (tests/offline); defaults to fetch. */
  transport?: JsonRpcTransport;
  /** CCC client override (tests/offline); defaults to a ClientPublicTestnet at the RPC endpoint. */
  cccClient?: CccClient;
  /** Request timeout for the default transport (ms). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FIND_LIMIT = 64;

/**
 * CEMP chain client. Reads are validated shape-by-shape (see the module
 * header); {@link CempClient.sendTransaction} is the single broadcast entry
 * point and is only ever called after a pre-broadcast journal write
 * (AGENTS.md rule 6).
 */
export class CempClient implements CkbIndexerProvider, CkbRpcProvider {
  readonly network: NetworkConfig;
  readonly endpoints: NetworkEndpoints;
  /** CCC client for transaction building / coin selection (never for broadcast here). */
  readonly ccc: CccClient;
  private readonly transport: JsonRpcTransport;

  constructor(options: CempClientOptions = {}) {
    this.network = options.network ?? CKB_TESTNET;
    const first = this.network.endpoints[0];
    if (first === undefined) {
      throw new CempCkbError("CempClient", `network "${this.network.name}" has no endpoints`);
    }
    this.endpoints = options.endpoints ?? first;
    this.transport =
      options.transport ?? fetchJsonRpcTransport(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.ccc = options.cccClient ?? new ClientPublicTestnet({ url: this.endpoints.rpc });
  }

  async getTipHeader(): Promise<Header> {
    const result = await this.transport.call(this.endpoints.rpc, "get_tip_header", []);
    return parseTipHeader(result);
  }

  /**
   * Broadcast a signed transaction via `send_transaction`; returns the
   * accepted transaction hash (validated as a 32-byte hash). The caller MUST
   * have written the pre-broadcast journal entry already (AGENTS.md rule 6)
   * and SHOULD cross-check the returned hash against the locally computed
   * `tx.hash()` of the signed transaction.
   *
   * `outputsValidator` defaults to `"passthrough"` because CEMP outputs use
   * scripts outside the node's well-known list (see the module header).
   */
  async sendTransaction(
    tx: Transaction,
    outputsValidator: OutputsValidator = "passthrough",
  ): Promise<Hash> {
    const body = transactionToRpc(tx);
    const result = await this.transport.call(this.endpoints.rpc, "send_transaction", [
      body,
      outputsValidator,
    ]);
    return asHash(result, "send_transaction result");
  }

  /**
   * Pre-broadcast simulation (spec Phase 11 task 11): `dry_run_transaction`
   * executes the transaction in the node's VM without broadcasting. Returns
   * the cycle count as a hex quantity; verification failures surface as RPC
   * errors (the caller maps them like send failures). The wire body is
   * validated by the same strict path as broadcast.
   */
  async dryRunTransaction(
    tx: Transaction,
    outputsValidator: OutputsValidator = "passthrough",
  ): Promise<{ cycles: string }> {
    const body = transactionToRpc(tx);
    const result = await this.transport.call(this.endpoints.rpc, "dry_run_transaction", [
      body,
      outputsValidator,
    ]);
    const rec = asRecord(result, "dry_run_transaction result");
    return { cycles: asU64Hex(rec.cycles, "dry_run_transaction result.cycles").hex };
  }

  /** Basis of the watched-outpoint pattern (spec §7.4): live → spent detection. */
  async getLiveCell(outPoint: OutPoint): Promise<LiveCellStatus> {
    const result = await this.transport.call(this.endpoints.rpc, "get_live_cell", [
      { tx_hash: outPoint.txHash, index: outPoint.index },
      true,
    ]);
    return parseLiveCellStatus(result, outPoint);
  }

  async getTransaction(hash: Hash): Promise<TransactionStatus> {
    const result = await this.transport.call(this.endpoints.rpc, "get_transaction", [hash]);
    const status = parseTransactionStatus(result, hash);
    // `get_transaction` reports only the committed block hash; resolve the
    // number with one follow-up so the interface contract is complete.
    if (status.status === "committed") {
      const header = await this.transport.call(this.endpoints.rpc, "get_header", [
        status.blockHash,
      ]);
      const parsed = parseTipHeader(header);
      return { ...status, blockNumber: parsed.number };
    }
    return status;
  }

  /**
   * The full transaction body (transfer history, Phase 4 task 6), or null
   * when the node does not know the hash. Shape-validated (rule 4).
   */
  async getTransactionBody(hash: Hash): Promise<Transaction | null> {
    const result = await this.transport.call(this.endpoints.rpc, "get_transaction", [hash]);
    if (result === null) {
      return null;
    }
    const rec = asRecord(result, "get_transaction result");
    return parseTransactionBody(rec.transaction, "get_transaction result.transaction");
  }

  async findCells(query: CellQuery): Promise<CellPage> {
    const searchKey: Record<string, unknown> = {
      script: scriptToRpc(query.script),
      script_type: query.scriptType,
      // Explicit on every call: the indexer's default is "prefix", and the
      // legacy args_search_mode field is silently ignored (live probe,
      // 2026-07-17) — never leave this to the server default.
      script_search_mode: query.argsSearchMode ?? "exact",
      with_data: true,
    };
    if (query.filter !== undefined) {
      searchKey.filter = filterToRpc(query.filter);
    }
    const params: unknown[] = [
      searchKey,
      query.order ?? "asc",
      toHexQuantity(query.limit ?? DEFAULT_FIND_LIMIT),
    ];
    if (query.after !== undefined) {
      params.push(query.after);
    }
    const result = await this.transport.call(this.endpoints.indexer, "get_cells", params);
    return parseCellsPage(result);
  }

  async findTransactions(query: CellQuery): Promise<TransactionPage> {
    const searchKey: Record<string, unknown> = {
      script: scriptToRpc(query.script),
      script_type: query.scriptType,
      script_search_mode: query.argsSearchMode ?? "exact",
    };
    if (query.filter !== undefined) {
      searchKey.filter = filterToRpc(query.filter);
    }
    const params: unknown[] = [
      searchKey,
      query.order ?? "asc",
      toHexQuantity(query.limit ?? DEFAULT_FIND_LIMIT),
    ];
    if (query.after !== undefined) {
      params.push(query.after);
    }
    const result = await this.transport.call(this.endpoints.indexer, "get_transactions", params);
    return parseTransactionsPage(result);
  }
}

function scriptToRpc(script: Script): Record<string, unknown> {
  return { code_hash: script.codeHash, hash_type: script.hashType, args: script.args };
}

function filterToRpc(filter: NonNullable<CellQuery["filter"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (filter.script !== undefined) {
    out.script = scriptToRpc(filter.script);
  }
  if (filter.outputDataLenRange !== undefined) {
    out.output_data_len_range = filter.outputDataLenRange;
  }
  if (filter.outputCapacityRange !== undefined) {
    out.output_capacity_range = filter.outputCapacityRange;
  }
  if (filter.blockRange !== undefined) {
    out.block_range = filter.blockRange;
  }
  return out;
}

function toHexQuantity(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CempCkbError("findCells", `limit must be a positive safe integer, got ${value}`);
  }
  return `0x${value.toString(16)}`;
}
