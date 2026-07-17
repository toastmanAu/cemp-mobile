/**
 * Offline `ccc.Client` stub for tests (extracted from builders.test.ts so
 * pipeline-level tests share it). Implements just what coin selection, fee
 * completion and input resolution touch: `findCellsPagedNoCache` (coin
 * selection), `getTransactionNoCache` (CCC resolves inputs through
 * `client.getCell` → `get_transaction`), `getCellLiveNoCache` (the signer's
 * default resolver path) and `getCellsCapacity`. Everything else throws. The
 * mock deliberately ignores search-key filters; tests only preload cells
 * that are meant to be collectable.
 *
 * Not exported from the package index — test-only.
 */

import {
  Cell,
  CellOutput,
  Client,
  ClientTransactionResponse,
  OutPoint,
  Script,
  ScriptInfo,
  bytesFrom,
  numFrom,
} from "@ckb-ccc/core";
import type {
  ClientBlock,
  ClientBlockHeader,
  ClientFindCellsResponse,
  ClientFindTransactionsGroupedResponse,
  ClientFindTransactionsResponse,
  ClientIndexerSearchKeyLike,
  ClientIndexerSearchKeyTransactionLike,
  HexLike,
  Num,
  NumLike,
  OutPointLike,
} from "@ckb-ccc/core";

export function fillHex(byte: number, length: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(length)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const DUMMY_LOCK = { codeHash: fillHex(0x00, 32), hashType: "type" as const, args: "0x" };

export function scriptEquals(a: Script, b: Script): boolean {
  return a.codeHash === b.codeHash && a.hashType === b.hashType && a.args === b.args;
}

/**
 * CCC class instances do not satisfy their own `*Like` types under this
 * repo's `exactOptionalPropertyTypes` (the known CCC 1.12.5 typing quirk), so
 * `CellLike`/`TransactionLike` literals are built as plain objects.
 */
export function toOutputLike(cellOutput: CellOutput): {
  capacity: Num;
  lock: Script;
  type: Script | null;
} {
  return {
    capacity: cellOutput.capacity,
    lock: cellOutput.lock,
    type: cellOutput.type ?? null,
  };
}

export class MockCkbClient extends Client {
  private readonly mockCells: Cell[] = [];

  addCells(...cells: Cell[]): void {
    this.mockCells.push(...cells);
  }

  get url(): string {
    return "mock://ckb";
  }

  get addressPrefix(): string {
    return "ckt";
  }

  getKnownScript(): Promise<ScriptInfo> {
    // CCC probes this for Nervos DAO extra-capacity checks; a dummy script
    // info that matches nothing keeps every test cell non-DAO.
    return Promise.resolve(
      ScriptInfo.from({ codeHash: fillHex(0xdd, 32), hashType: "type", cellDeps: [] }),
    );
  }

  getFeeRateStatistics(): Promise<{ mean: Num; median: Num }> {
    return Promise.resolve({ mean: 1000n, median: 1000n });
  }

  getTip(): Promise<Num> {
    return Promise.resolve(1n);
  }

  getTipHeader(): Promise<ClientBlockHeader> {
    return Promise.reject(new Error("mock: not implemented"));
  }

  getBlockByNumberNoCache(): Promise<ClientBlock | undefined> {
    return Promise.reject(new Error("mock: not implemented"));
  }

  getBlockByHashNoCache(): Promise<ClientBlock | undefined> {
    return Promise.reject(new Error("mock: not implemented"));
  }

  getHeaderByNumberNoCache(): Promise<ClientBlockHeader | undefined> {
    return Promise.reject(new Error("mock: not implemented"));
  }

  getHeaderByHashNoCache(): Promise<ClientBlockHeader | undefined> {
    return Promise.reject(new Error("mock: not implemented"));
  }

  estimateCycles(): Promise<Num> {
    return Promise.reject(new Error("mock: not implemented"));
  }

  sendTransactionDry(): Promise<Num> {
    return Promise.reject(new Error("mock: broadcasting is out of scope"));
  }

  sendTransactionNoCache(): Promise<`0x${string}`> {
    return Promise.reject(new Error("mock: broadcasting is out of scope"));
  }

  getTransactionNoCache(txHashLike: HexLike): Promise<ClientTransactionResponse | undefined> {
    const txHash = `0x${bytesToHex(bytesFrom(txHashLike))}`;
    const matched = this.mockCells.filter((cell) => cell.outPoint.txHash === txHash);
    if (matched.length === 0) {
      return Promise.resolve(undefined);
    }
    const maxIndex = Math.max(...matched.map((cell) => Number(cell.outPoint.index)));
    const outputs = [];
    const outputsData = [];
    for (let i = 0; i <= maxIndex; i++) {
      const cell = matched.find((candidate) => Number(candidate.outPoint.index) === i);
      outputs.push(
        cell ? toOutputLike(cell.cellOutput) : { capacity: 0, lock: DUMMY_LOCK, type: null },
      );
      outputsData.push(cell ? cell.outputData : "0x");
    }
    return Promise.resolve(
      ClientTransactionResponse.from({
        transaction: { outputs, outputsData },
        status: "committed",
      }),
    );
  }

  getCellLiveNoCache(outPointLike: OutPointLike): Promise<Cell | undefined> {
    const outPoint = OutPoint.from(outPointLike);
    return Promise.resolve(this.mockCells.find((cell) => cell.outPoint.eq(outPoint)));
  }

  findCellsPagedNoCache(
    keyLike: ClientIndexerSearchKeyLike,
    _order?: "asc" | "desc",
    limit: NumLike = 10,
    after?: string,
  ): Promise<ClientFindCellsResponse> {
    const script = Script.from(keyLike.script);
    const all = this.mockCells.filter((cell) => {
      const candidate = keyLike.scriptType === "lock" ? cell.cellOutput.lock : cell.cellOutput.type;
      return candidate !== undefined && scriptEquals(candidate, script);
    });
    const start = after === undefined ? 0 : Number(after);
    const pageSize = Number(numFrom(limit));
    const slice = all.slice(start, start + pageSize);
    return Promise.resolve({ lastCursor: String(start + slice.length), cells: slice });
  }

  findTransactionsPaged(
    _key: Omit<ClientIndexerSearchKeyTransactionLike, "groupByTransaction"> & {
      groupByTransaction: true;
    },
  ): Promise<ClientFindTransactionsGroupedResponse>;
  findTransactionsPaged(
    _key: ClientIndexerSearchKeyTransactionLike,
  ): Promise<ClientFindTransactionsResponse>;
  findTransactionsPaged(): Promise<unknown> {
    return Promise.reject(new Error("mock: not implemented"));
  }

  getCellsCapacity(keyLike: ClientIndexerSearchKeyLike): Promise<Num> {
    const script = Script.from(keyLike.script);
    const total = this.mockCells
      .filter((cell) => scriptEquals(cell.cellOutput.lock, script))
      .reduce((sum, cell) => sum + cell.cellOutput.capacity, 0n);
    return Promise.resolve(total);
  }
}
