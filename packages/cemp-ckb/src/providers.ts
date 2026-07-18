import type {
  Cell,
  Hash,
  Header,
  HexString,
  LiveCellStatus,
  OutPoint,
  Script,
  Transaction,
  TransactionStatus,
} from "./types.js";

/**
 * Provider interfaces (spec §13). Implementations must treat all RPC and
 * indexer responses as hostile input (AGENTS.md rule 4): validate shapes,
 * sizes and ranges before use.
 */

export interface CkbRpcProvider {
  getTipHeader(): Promise<Header>;
  sendTransaction(tx: Transaction): Promise<Hash>;
  getTransaction(hash: Hash): Promise<TransactionStatus>;
  /** Full transaction body (transfer history, Phase 4 task 6); null when unknown. */
  getTransactionBody(hash: Hash): Promise<Transaction | null>;
  /** Basis of the watched-outpoint pattern (spec §7.4): live → spent detection. */
  getLiveCell(outPoint: OutPoint): Promise<LiveCellStatus>;
}

export type ScriptType = "lock" | "type";

export interface CellQuery {
  script: Script;
  scriptType: ScriptType;
  /**
   * Args prefix search ("prefix" is required for route-tag discovery,
   * spec §6.1: type args = version || route_tag || conversation_tag || nonce).
   */
  argsSearchMode?: "exact" | "prefix";
  filter?: {
    script?: Script;
    outputDataLenRange?: [HexString, HexString];
    outputCapacityRange?: [HexString, HexString];
    blockRange?: [HexString, HexString];
  };
  /** Pagination cursor from a previous response (spec §12 sync cursors). */
  after?: string;
  limit?: number;
  order?: "asc" | "desc";
}

export interface CellPage {
  cells: Cell[];
  /** Opaque indexer cursor; pass back as CellQuery.after. */
  lastCursor: string;
}

export interface IndexedTransaction {
  txHash: Hash;
  blockNumber: string;
  txIndex: string;
  ioType: "input" | "output";
  ioIndex: string;
}

export interface TransactionPage {
  transactions: IndexedTransaction[];
  lastCursor: string;
}

export interface CkbIndexerProvider {
  findCells(query: CellQuery): Promise<CellPage>;
  findTransactions(query: CellQuery): Promise<TransactionPage>;
}

/** CKBFS image transport (spec §9; Phase 10 — excluded from the first MVP). */
export interface CkbfsUploadPlan {
  rootOutPoint: OutPoint;
  chunkOutpoints: OutPoint[];
  totalCapacity: string;
  transactions: Transaction[];
}

export interface CkbfsManifest {
  root: OutPoint;
  chunks: OutPoint[];
  encryptedSize: number;
}

export interface ReclaimPlan {
  transaction: Transaction;
  reclaimedCapacity: string;
}

export interface CkbfsProvider {
  buildUpload(data: Uint8Array, owner: Script): Promise<CkbfsUploadPlan>;
  fetch(manifest: CkbfsManifest): Promise<Uint8Array>;
  buildReclaim(manifest: CkbfsManifest): Promise<ReclaimPlan>;
}
