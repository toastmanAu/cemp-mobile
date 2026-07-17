import {
  Cell,
  CellOutput,
  Client,
  ClientTransactionResponse,
  OutPoint,
  Script,
  ScriptInfo,
  Transaction,
  bytesFrom,
  fixedPointFrom,
  hashTypeId,
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
import { CKB_TESTNET, codec } from "@cemp/core";
import { mldsaV2KeygenFromSeed } from "@cemp/crypto";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import {
  TYPE_ID_CODE_HASH,
  buildCreateProfileTx,
  buildDeployDataCellTx,
  buildMessageTypeArgs,
  buildReclaimTx,
  buildSendMessageTx,
} from "./builders.js";
import { MlDsaV2TxSigner, staticCellResolver } from "./signing.js";
import type { ResolvedInput } from "./cighash.js";
import type { Cell as WireCell } from "./types.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fill(byte: number, length: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(length)}`;
}

// ── mock CCC client (offline coin selection / resolution) ──────────────────

const DUMMY_LOCK = { codeHash: fill(0x00, 32), hashType: "type" as const, args: "0x" };

function scriptEquals(a: Script, b: Script): boolean {
  return a.codeHash === b.codeHash && a.hashType === b.hashType && a.args === b.args;
}

/**
 * CCC class instances do not satisfy their own `*Like` types under this
 * repo's `exactOptionalPropertyTypes` (the known CCC 1.12.5 typing quirk), so
 * `CellLike`/`TransactionLike` literals are built as plain objects.
 */
function toOutputLike(cellOutput: CellOutput): {
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

/**
 * Offline `ccc.Client` stub. Implements just what coin selection, fee
 * completion and input resolution touch: `findCellsPagedNoCache` (coin
 * selection), `getTransactionNoCache` (CCC resolves inputs through
 * `client.getCell` → `get_transaction`), `getCellLiveNoCache` (the signer's
 * default resolver path) and `getCellsCapacity`. Everything else throws. The
 * mock deliberately ignores search-key filters; tests only preload cells
 * that are meant to be collectable.
 */
class MockCkbClient extends Client {
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
      ScriptInfo.from({ codeHash: fill(0xdd, 32), hashType: "type", cellDeps: [] }),
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

// ── fixtures ────────────────────────────────────────────────────────────────

const keyPair = mldsaV2KeygenFromSeed(hexToBytes(vectors.keygen[0]!.seed));

/** Cell-construction signer; every test signer shares the keypair → same lock. */
const fixtureSigner = new MlDsaV2TxSigner({ keyPair, client: new MockCkbClient() });

function makeSigner(...cells: Cell[]): { signer: MlDsaV2TxSigner; client: MockCkbClient } {
  const client = new MockCkbClient();
  client.addCells(...cells);
  return { signer: new MlDsaV2TxSigner({ keyPair, client }), client };
}

function fundingCell(ckb: number, seed: number): Cell {
  return Cell.from({
    outPoint: { txHash: fill(seed, 32), index: 0 },
    cellOutput: toOutputLike(
      CellOutput.from({
        capacity: fixedPointFrom(ckb),
        lock: fixtureSigner.lockScript(),
      }),
    ),
    outputData: "0x",
  });
}

/** Resolve a built tx's inputs, in tx order, from the preloaded cells. */
function resolveInOrder(tx: Transaction, cells: Cell[]): ResolvedInput[] {
  return tx.inputs.map((input) => {
    const cell = cells.find((candidate) => candidate.outPoint.eq(input.previousOutput));
    if (cell === undefined) {
      throw new Error(`test setup: no preloaded cell for ${input.previousOutput.txHash}`);
    }
    return { cellOutput: cell.cellOutput, data: bytesFrom(cell.outputData) };
  });
}

const mlDsaDeployment = CKB_TESTNET.deployments.mlDsaLock!;

describe("buildCreateProfileTx", () => {
  it("builds a Type ID profile cell with codec-decodable data", async () => {
    const funds = [fundingCell(5000, 0xf1), fundingCell(6000, 0xf2)];
    const { signer } = makeSigner(...funds);
    const profile = codec.buildProfileMinimal();

    const { tx, estimatedFee, resolvedInputsDescription } = await buildCreateProfileTx({
      profile,
      signer,
    });

    const output = tx.outputs[0]!;
    expect(output.type).toBeDefined();
    const type = output.type!;
    expect(type.codeHash).toBe(TYPE_ID_CODE_HASH);
    expect(type.hashType).toBe("type");
    expect(type.args).toBe(hashTypeId({ previousOutput: tx.inputs[0]!.previousOutput }, 0));
    expect(scriptEquals(output.lock, signer.lockScript())).toBe(true);

    // Data round-trips through the strict v1 codec.
    const data = bytesFrom(tx.outputsData[0]!);
    const decoded = codec.decodeCempProfileV1(data);
    expect(bytesToHex(codec.encodeCempProfileV1(decoded))).toBe(bytesToHex(data));

    // The v2 lock cell dep and placeholder witnesses were prepared for signing.
    expect(tx.cellDeps.some((dep) => dep.outPoint.txHash === mlDsaDeployment.txHash)).toBe(true);
    expect(tx.witnesses.length).toBeGreaterThanOrEqual(tx.inputs.length);

    expect(estimatedFee > 0n).toBe(true);
    expect(resolvedInputsDescription.length).toBe(tx.inputs.length);
    expect(resolvedInputsDescription[0]!.txHash).toBe(tx.inputs[0]!.previousOutput.txHash);

    // The built tx signs and self-verifies offline (end-to-end wiring).
    const resolver = staticCellResolver(
      funds.map((cell) => ({
        outPoint: cell.outPoint,
        cellOutput: cell.cellOutput,
        data: bytesFrom(cell.outputData),
      })),
    );
    const signed = await signer.signTransaction(tx, resolver);
    expect(signer.verifyOwnSignature(signed, resolveInOrder(tx, funds))).toBe(true);
  });
});

describe("buildSendMessageTx", () => {
  const routeTag = new Uint8Array(32).fill(0x72);
  const conversationTag = new Uint8Array(16).fill(0x63);
  const messageNonce = new Uint8Array(16).fill(0x6e);
  const messageTypeCellDep = { txHash: fill(0x44, 32), index: "0x0", depType: "code" as const };
  const cempMessageType = {
    codeHash: fill(0x22, 32),
    hashType: "type" as const,
    cellDep: messageTypeCellDep,
  };

  it("builds a sender-owned message cell with the 81-byte type args layout", async () => {
    const funds = [fundingCell(3000, 0xf3)];
    const { signer } = makeSigner(...funds);
    const envelopeBytes = codec.encodeCempEnvelopeV1(codec.buildEnvelope(false));

    const { tx, estimatedFee } = await buildSendMessageTx({
      envelopeBytes,
      routeTag,
      conversationTag,
      messageNonce,
      sender: signer,
      cempMessageType,
    });

    const output = tx.outputs[0]!;
    expect(scriptEquals(output.lock, signer.lockScript())).toBe(true);
    const type = output.type!;
    expect(type.codeHash).toBe(cempMessageType.codeHash);
    expect(type.hashType).toBe(cempMessageType.hashType);
    const args = bytesFrom(type.args);
    expect(args.length).toBe(81);
    expect(args[0]).toBe(0x01);
    expect(bytesToHex(args.subarray(1, 33))).toBe(bytesToHex(routeTag));
    expect(bytesToHex(args.subarray(33, 49))).toBe(bytesToHex(conversationTag));
    expect(bytesToHex(args.subarray(49, 65))).toBe(bytesToHex(messageNonce));
    // Trailing reserved bytes are zero-filled (spec §6 discrepancy note in builders.ts).
    expect(args.subarray(65, 81).every((byte) => byte === 0)).toBe(true);
    expect(bytesToHex(bytesFrom(tx.outputsData[0]!))).toBe(bytesToHex(envelopeBytes));
    // The message type script's code cell is in the deps (it executes on create).
    expect(
      tx.cellDeps.some(
        (dep) =>
          dep.outPoint.txHash === messageTypeCellDep.txHash &&
          dep.depType === messageTypeCellDep.depType,
      ),
    ).toBe(true);
    expect(estimatedFee > 0n).toBe(true);
  });

  it("throws when the CEMP message type script is not deployed", async () => {
    const { signer } = makeSigner(fundingCell(1000, 0xf4));
    const envelopeBytes = codec.encodeCempEnvelopeV1(codec.buildEnvelope(false));
    await expect(
      buildSendMessageTx({
        envelopeBytes,
        routeTag,
        conversationTag,
        messageNonce,
        sender: signer,
        cempMessageType: null,
      }),
    ).rejects.toThrow(/refusing to build a message cell/);
  });

  it("rejects an oversized envelope and bad tag lengths", async () => {
    const { signer } = makeSigner(fundingCell(1000, 0xf5));
    const huge = new Uint8Array(codec.V1_LIMITS.maxEnvelopeBytes + 1);
    await expect(
      buildSendMessageTx({
        envelopeBytes: huge,
        routeTag,
        conversationTag,
        messageNonce,
        sender: signer,
        cempMessageType,
      }),
    ).rejects.toThrow(/exceeds the/);
    expect(() => buildMessageTypeArgs(new Uint8Array(31), conversationTag, messageNonce)).toThrow(
      /route_tag/,
    );
  });
});

describe("buildReclaimTx", () => {
  function messageCell(ckb: number, seed: number): Cell {
    return Cell.from({
      outPoint: { txHash: fill(seed, 32), index: 1 },
      cellOutput: toOutputLike(
        CellOutput.from({
          capacity: fixedPointFrom(ckb),
          lock: fixtureSigner.lockScript(),
          type: {
            codeHash: fill(0x22, 32),
            hashType: "type",
            args: `0x01${"72".repeat(32)}${"63".repeat(16)}${"6e".repeat(16)}${"00".repeat(16)}`,
          },
        }),
      ),
      outputData: "0x1234",
    });
  }

  function toWireCell(cell: Cell): WireCell {
    const type = cell.cellOutput.type;
    return {
      outPoint: { txHash: cell.outPoint.txHash, index: `0x${cell.outPoint.index.toString(16)}` },
      output: {
        capacity: `0x${cell.cellOutput.capacity.toString(16)}`,
        lock: {
          codeHash: cell.cellOutput.lock.codeHash,
          hashType: cell.cellOutput.lock.hashType,
          args: cell.cellOutput.lock.args,
        },
        type:
          type === undefined
            ? null
            : { codeHash: type.codeHash, hashType: type.hashType, args: type.args },
      },
      data: cell.outputData,
    };
  }

  const messageTypeCellDep = { txHash: fill(0x44, 32), index: "0x0", depType: "code" as const };

  it("consumes exactly the given outpoints and consolidates to the sender lock", async () => {
    const messages = [messageCell(500, 0xa1), messageCell(300, 0xa2)];
    // Fee completion resolves the reclaimed cells through the mock chain.
    const { signer } = makeSigner(...messages);
    const wireCells = messages.map(toWireCell);
    const outpoints = wireCells.map((cell) => cell.outPoint);

    const { tx, estimatedFee, resolvedInputsDescription } = await buildReclaimTx({
      outpoints,
      resolvedCells: wireCells,
      signer,
      messageTypeCellDep,
    });

    expect(tx.inputs.length).toBe(2);
    expect(tx.inputs[0]!.previousOutput.txHash).toBe(outpoints[0]!.txHash);
    expect(tx.inputs[1]!.previousOutput.txHash).toBe(outpoints[1]!.txHash);

    // The spent cells' type script executes: its code cell is in the deps.
    expect(tx.cellDeps.some((dep) => dep.outPoint.txHash === messageTypeCellDep.txHash)).toBe(true);

    // One consolidation output back to the sender's own lock.
    expect(tx.outputs.length).toBe(1);
    expect(scriptEquals(tx.outputs[0]!.lock, signer.lockScript())).toBe(true);
    const totalIn = fixedPointFrom(500) + fixedPointFrom(300);
    expect(tx.outputs[0]!.capacity).toBe(totalIn - estimatedFee);
    expect(estimatedFee > 0n).toBe(true);
    expect(resolvedInputsDescription.map((d) => d.capacity)).toEqual([
      fixedPointFrom(500).toString(),
      fixedPointFrom(300).toString(),
    ]);

    // The reclaim tx also signs and self-verifies offline.
    const resolver = staticCellResolver(
      messages.map((cell) => ({
        outPoint: cell.outPoint,
        cellOutput: cell.cellOutput,
        data: bytesFrom(cell.outputData),
      })),
    );
    const signed = await signer.signTransaction(tx, resolver);
    expect(signer.verifyOwnSignature(signed, resolveInOrder(tx, messages))).toBe(true);
  });

  it("refuses cells not locked by the sender (rule 9)", async () => {
    const { signer } = makeSigner();
    const foreign = messageCell(500, 0xb1);
    foreign.cellOutput.lock = Script.from({
      codeHash: fill(0x99, 32),
      hashType: "type",
      args: "0x01",
    });
    await expect(
      buildReclaimTx({
        outpoints: [{ txHash: foreign.outPoint.txHash, index: "0x1" }],
        resolvedCells: [toWireCell(foreign)],
        signer,
        messageTypeCellDep,
      }),
    ).rejects.toThrow(/reclaim authority/);
  });

  it("rejects resolved cells that do not match the outpoints", async () => {
    const { signer } = makeSigner();
    const wire = toWireCell(messageCell(500, 0xc1));
    await expect(
      buildReclaimTx({
        outpoints: [{ txHash: fill(0xd9, 32), index: "0x1" }],
        resolvedCells: [wire],
        signer,
        messageTypeCellDep,
      }),
    ).rejects.toThrow(/does not match/);
  });
});

describe("buildDeployDataCellTx", () => {
  it("builds a typeless data cell sized to occupied + margin", async () => {
    const funds = [fundingCell(5000, 0xe1)];
    const { signer } = makeSigner(...funds);
    const data = new Uint8Array(100).fill(0xab);

    const { tx, estimatedFee, resolvedInputsDescription } = await buildDeployDataCellTx({
      data,
      signer,
    });

    const output = tx.outputs[0]!;
    expect(scriptEquals(output.lock, signer.lockScript())).toBe(true);
    expect(output.type).toBeUndefined();
    expect(bytesToHex(bytesFrom(tx.outputsData[0]!))).toBe(bytesToHex(data));
    // Occupied minimum for 8 (capacity) + lock + 100 data bytes, plus margin.
    const occupied = fixedPointFrom(8 + signer.lockScript().occupiedSize + data.length);
    expect(output.capacity).toBe(occupied + 100_000_000n);
    expect(estimatedFee > 0n).toBe(true);
    expect(resolvedInputsDescription.length).toBe(tx.inputs.length);

    const resolver = staticCellResolver(
      funds.map((cell) => ({
        outPoint: cell.outPoint,
        cellOutput: cell.cellOutput,
        data: bytesFrom(cell.outputData),
      })),
    );
    const signed = await signer.signTransaction(tx, resolver);
    expect(signer.verifyOwnSignature(signed, resolveInOrder(tx, funds))).toBe(true);
  });

  it("refuses empty data", async () => {
    const { signer } = makeSigner(fundingCell(500, 0xe2));
    await expect(buildDeployDataCellTx({ data: new Uint8Array(0), signer })).rejects.toThrow(
      /empty data cell/,
    );
  });
});
