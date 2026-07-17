/**
 * Minimal CKB data types used by the provider interfaces (spec §13).
 * These are structural and hex-string based; the CCC SDK is the reference
 * implementation behind these interfaces (see docs/grounding/).
 */

/** 32-byte hash, 0x-prefixed hex. */
export type Hash = string;
/** 0x-prefixed hex bytes. */
export type HexString = string;
/** Capacity in shannons, encoded as 0x-prefixed hex uint64. */
export type Capacity = string;

export type HashType = "type" | "data" | "data1" | "data2";

export interface Script {
  codeHash: Hash;
  hashType: HashType;
  args: HexString;
}

export interface OutPoint {
  txHash: Hash;
  /** Hex-encoded uint32 index, as used by CKB RPC. */
  index: string;
}

export interface CellDep {
  outPoint: OutPoint;
  depType: "code" | "depGroup";
}

export interface CellInput {
  previousOutput: OutPoint;
  since: string;
}

export interface CellOutput {
  capacity: Capacity;
  lock: Script;
  type: Script | null;
}

export interface Cell {
  outPoint: OutPoint;
  output: CellOutput;
  data: HexString;
  /**
   * Block the cell was created in. Always present for indexer results;
   * absent for `get_live_cell` views, which do not report it.
   */
  blockNumber?: string;
}

export interface Transaction {
  version: string;
  cellDeps: CellDep[];
  headerDeps: Hash[];
  inputs: CellInput[];
  outputs: CellOutput[];
  outputsData: HexString[];
  witnesses: HexString[];
}

export interface Header {
  number: string;
  epoch: string;
  timestamp: string;
  hash: Hash;
}

export type TransactionStatus =
  | { status: "sent" | "pending" | "proposed"; txHash: Hash }
  | { status: "committed"; txHash: Hash; blockHash: Hash; blockNumber: string }
  | { status: "rejected" | "unknown"; txHash: Hash; reason?: string };

export type LiveCellStatus =
  | { status: "live"; cell: Cell }
  | { status: "dead"; outPoint: OutPoint }
  | { status: "unknown"; outPoint: OutPoint };
