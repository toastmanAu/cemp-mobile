import { Cell, CellOutput, Script, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET } from "@cemp/core";
import { mldsaV2KeygenFromSeed } from "@cemp/crypto";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import { buildConsolidateTx, buildMessageTypeArgs, buildTransferTx } from "./builders.js";
import type { CempClient } from "./client.js";
import { MlDsaV2TxSigner, staticCellResolver } from "./signing.js";
import { MockCkbClient, fillHex, toOutputLike } from "./testing/mock-ccc-client.js";
import type { Cell as WireCell } from "./types.js";
import {
  addressFromLockScript,
  balanceCategories,
  balanceSummary,
  faucetClaimInstructions,
  lockFromAddress,
  messageCellCapacity,
  transferHistory,
} from "./wallet.js";

/**
 * Phase 4 wallet foundation: address helpers, balance categories, transfer
 * history, transfer + consolidation builders — offline against the mock
 * chain, end-to-end signed where a builder is involved.
 */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const keyPair = mldsaV2KeygenFromSeed(hexToBytes(vectors.keygen[0]!.seed));
const fixtureSigner = new MlDsaV2TxSigner({ keyPair, client: new MockCkbClient() });

function makeSigner(...cells: Cell[]): { signer: MlDsaV2TxSigner; client: MockCkbClient } {
  const client = new MockCkbClient();
  client.addCells(...cells);
  return { signer: new MlDsaV2TxSigner({ keyPair, client }), client };
}

function fundingCell(ckb: number, seed: number): Cell {
  return Cell.from({
    outPoint: { txHash: fillHex(seed, 32), index: 0 },
    cellOutput: toOutputLike(
      CellOutput.from({ capacity: fixedPointFrom(ckb), lock: fixtureSigner.lockScript() }),
    ),
    outputData: "0x",
  });
}

function messageCell(ckb: number, seed: number): Cell {
  const typeArgs = buildMessageTypeArgs(
    hexToBytes("aa".repeat(32)),
    hexToBytes("bb".repeat(16)),
    hexToBytes("cc".repeat(16)),
  );
  return Cell.from({
    outPoint: { txHash: fillHex(seed, 32), index: 0 },
    cellOutput: toOutputLike(
      CellOutput.from({
        capacity: fixedPointFrom(ckb),
        lock: fixtureSigner.lockScript(),
        type: {
          codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
          hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
          args: hexFrom(typeArgs),
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

describe("addresses (task 2)", () => {
  it("lock → address → lock round-trips on testnet (ckt1 prefix)", async () => {
    const { client } = makeSigner();
    const address = addressFromLockScript(fixtureSigner.lockScript(), client);
    expect(address.startsWith("ckt1")).toBe(true);
    const lock = await lockFromAddress(address, client);
    expect(lock.codeHash).toBe(fixtureSigner.lockScript().codeHash);
    expect(lock.args).toBe(fixtureSigner.lockScript().args);
  });

  it("faucet instructions carry the address and stay manual", () => {
    const instructions = faucetClaimInstructions("ckt1qexample");
    expect(instructions).toContain("https://faucet.nervos.org");
    expect(instructions).toContain("ckt1qexample");
  });
});

describe("balance categories (tasks 3, 7)", () => {
  it("separates protocol cells from freely spendable ones", async () => {
    const plain1 = fundingCell(1000, 0xf1);
    const plain2 = fundingCell(2000, 0xf2);
    const protocol = messageCell(500, 0xc1);
    // balanceCategories talks to the indexer through collectCells — use the
    // mock CCC client's findCells via a thin provider shim.
    const provider = {
      findCells: (query: { script: { codeHash: string } }) => {
        const all = [plain1, plain2, protocol].map(toWireCell);
        return Promise.resolve({
          cells: all.filter((cell) => cell.output.lock.codeHash === query.script.codeHash),
          lastCursor: "0x0",
        });
      },
    };
    const categories = await balanceCategories(
      provider as unknown as CempClient,
      toWireCell(plain1).output.lock,
      {
        codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
        hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
      },
    );
    expect(categories.totalShannon).toBe(fixedPointFrom(3500));
    expect(categories.reservedShannon).toBe(fixedPointFrom(500));
    expect(categories.availableShannon).toBe(fixedPointFrom(3000));
    expect(categories.reclaimableShannon).toBe(fixedPointFrom(500));
    expect(categories.protocolCellCount).toBe(1);
    expect(balanceSummary([toWireCell(plain1), toWireCell(plain2)]).total).toBe(
      fixedPointFrom(3000),
    );
  });

  it("messageCellCapacity is the occupied minimum (8 + lock + type + data)", () => {
    const lock = Script.from(fixtureSigner.lockScript());
    const typeOccupied = 32 + 1 + 81; // codeHash + hashType + 81-byte args
    const capacity = messageCellCapacity(1000, fixtureSigner.lockScript(), {
      codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
      hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
    });
    expect(capacity).toBe(fixedPointFrom(8 + lock.occupiedSize + typeOccupied + 1000));
  });
});

describe("buildTransferTx (task 5)", () => {
  it("pays the exact amount to the recipient and self-verifies offline", async () => {
    const funds = [fundingCell(5000, 0xf1)];
    const { signer } = makeSigner(...funds);
    const recipientLock = { ...fixtureSigner.lockScript(), args: `0x${"42".repeat(37)}` };
    const { tx, estimatedFee } = await buildTransferTx({
      recipientLock,
      amountShannon: fixedPointFrom(1000),
      signer,
    });
    expect(tx.outputs[0]!.capacity).toBe(fixedPointFrom(1000));
    expect(tx.outputs[0]!.lock.args).toBe(recipientLock.args);
    expect(estimatedFee > 0n).toBe(true);
    const resolver = staticCellResolver(
      funds.map((cell) => ({
        outPoint: cell.outPoint,
        cellOutput: cell.cellOutput,
        data: hexToBytes(cell.outputData.slice(2)),
      })),
    );
    const signed = await signer.signTransaction(tx, resolver);
    expect(signed.witnesses.length).toBeGreaterThan(0);
  });

  it("rejects dust below the occupied minimum and non-positive amounts", async () => {
    const { signer } = makeSigner(fundingCell(5000, 0xf1));
    await expect(
      buildTransferTx({ recipientLock: fixtureSigner.lockScript(), amountShannon: 1n, signer }),
    ).rejects.toThrow(/occupied minimum/);
    await expect(
      buildTransferTx({ recipientLock: fixtureSigner.lockScript(), amountShannon: 0n, signer }),
    ).rejects.toThrow(/positive/);
  });
});

describe("buildConsolidateTx (task 9)", () => {
  it("merges plain cells into one output; refuses protocol cells and foreign locks", async () => {
    const cells = [fundingCell(100, 0xf1), fundingCell(200, 0xf2), fundingCell(300, 0xf3)];
    const { signer } = makeSigner(...cells);
    const { tx, resolvedInputsDescription } = await buildConsolidateTx({
      cells: cells.map(toWireCell),
      signer,
    });
    expect(tx.inputs.length).toBe(3);
    expect(resolvedInputsDescription).toHaveLength(3);
    expect(tx.outputs.length).toBe(1); // the single consolidated change output
    expect(tx.outputs[0]!.capacity > fixedPointFrom(590)).toBe(true);

    // Protocol cell refuses.
    const withProtocol = [...cells.map(toWireCell), toWireCell(messageCell(500, 0xc9))];
    await expect(buildConsolidateTx({ cells: withProtocol, signer })).rejects.toThrow(
      /type script/,
    );
  });
});

describe("transferHistory (task 6)", () => {
  it("classifies received vs sent by net lock delta", async () => {
    const lock = toWireCell(fundingCell(1, 0)).output.lock;
    const receivedTxHash = fillHex(0xa1, 32);
    const sentTxHash = fillHex(0xa2, 32);
    const foreignTxHash = fillHex(0xa3, 32);
    const body = (outputs: { capacity: bigint; lock: unknown }[], inputs: unknown[] = []) => ({
      version: "0x0",
      cell_deps: [],
      header_deps: [],
      inputs,
      outputs: outputs.map((output) => ({
        capacity: `0x${output.capacity.toString(16)}`,
        lock: output.lock,
        type: null,
      })),
      outputs_data: outputs.map(() => "0x"),
      witnesses: [],
    });
    const foreignLock = {
      codeHash: fillHex(0x77, 32),
      hashType: "type",
      args: `0x${"42".repeat(37)}`,
    };
    const ownLockRpc = { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args };
    const bodies = new Map<string, unknown>([
      // received: one output to us, no inputs of ours.
      [receivedTxHash, body([{ capacity: fixedPointFrom(700), lock: ownLockRpc }], [])],
      // sent: we spend a 1000 cell, pay 300 out, get 690 change (fee 10).
      [
        sentTxHash,
        body(
          [
            { capacity: fixedPointFrom(300), lock: foreignLock },
            { capacity: fixedPointFrom(690), lock: ownLockRpc },
          ],
          [{ previousOutput: { txHash: foreignTxHash, index: "0x0" }, since: "0x0" }],
        ),
      ],
      // the source tx of the spent input: 1000 to us.
      [foreignTxHash, body([{ capacity: fixedPointFrom(1000), lock: ownLockRpc }], [])],
    ]);
    const provider = {
      findTransactions: () =>
        Promise.resolve({
          transactions: [
            { txHash: sentTxHash, blockNumber: "0x2", txIndex: "0x0", ioType: "input" },
            { txHash: receivedTxHash, blockNumber: "0x1", txIndex: "0x0", ioType: "output" },
          ],
          lastCursor: "0x0",
        }),
      getTransactionBody: (hash: string) => Promise.resolve(bodies.get(hash) ?? null),
    };
    const page = await transferHistory(provider as unknown as CempClient, lock);
    expect(page.records).toHaveLength(2);
    expect(page.records[0]!.direction).toBe("sent");
    // sent delta = change(690) − spent(1000) = −310 CKB.
    expect(page.records[0]!.deltaShannon).toBe(fixedPointFrom(690) - fixedPointFrom(1000));
    expect(page.records[1]!.direction).toBe("received");
    expect(page.records[1]!.deltaShannon).toBe(fixedPointFrom(700));
  });
});
