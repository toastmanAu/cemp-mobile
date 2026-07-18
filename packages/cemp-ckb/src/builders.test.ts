import {
  Cell,
  CellOutput,
  Script,
  Transaction,
  bytesFrom,
  fixedPointFrom,
  hashTypeId,
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
  buildRotateProfileTx,
  buildSendMessageTx,
} from "./builders.js";
import { MlDsaV2TxSigner, staticCellResolver } from "./signing.js";
import type { ResolvedInput } from "./cighash.js";
import { MockCkbClient, scriptEquals, toOutputLike } from "./testing/mock-ccc-client.js";
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

describe("buildRotateProfileTx", () => {
  const OLD_TYPE_ARGS = `0x${"ab".repeat(32)}`;

  function oldProfileCell(ckb: number, seed: number, lock = fixtureSigner.lockScript()): Cell {
    return Cell.from({
      outPoint: { txHash: fill(seed, 32), index: 0 },
      cellOutput: toOutputLike(
        CellOutput.from({
          capacity: fixedPointFrom(ckb),
          lock,
          type: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: OLD_TYPE_ARGS },
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

  it("spends the current profile cell and issues the successor with a new Type ID", async () => {
    const oldCell = oldProfileCell(4000, 0xb1);
    const funds = [fundingCell(2000, 0xf3)];
    const { signer } = makeSigner(oldCell, ...funds);
    const rotatedLock = { ...signer.lockScript(), args: `0x${"cd".repeat(37)}` };
    const newProfile = {
      ...codec.buildProfileMinimal(),
      rotation_sequence: 1,
      previous_profile_id: bytesFrom(OLD_TYPE_ARGS),
    };

    const { tx, estimatedFee } = await buildRotateProfileTx({
      oldProfileCell: toWireCell(oldCell),
      newProfile,
      newLock: rotatedLock,
      signer,
    });

    // Input 0 is the spent profile cell (the rotation recipe's anchor).
    expect(tx.inputs[0]!.previousOutput.txHash).toBe(oldCell.outPoint.txHash);
    const output = tx.outputs[0]!;
    // The NEW Type ID derives from the spent cell's outpoint at output index 0.
    expect(output.type!.args).toBe(hashTypeId({ previousOutput: tx.inputs[0]!.previousOutput }, 0));
    expect(output.type!.args).not.toBe(OLD_TYPE_ARGS);
    // The rotated lock owns the successor; the old cell's capacity rolls over.
    expect(output.lock.args).toBe(rotatedLock.args);
    expect(output.capacity >= fixedPointFrom(4000)).toBe(true);
    // Rotation fields survive the codec round-trip.
    const decoded = codec.decodeCempProfileV1(bytesFrom(tx.outputsData[0]!));
    expect(decoded.rotation_sequence).toBe(1);
    expect(`0x${bytesToHex(decoded.previous_profile_id!)}`).toBe(OLD_TYPE_ARGS);
    // Type ID dep present; tx signable offline.
    expect(tx.cellDeps.some((dep) => dep.outPoint.txHash === mlDsaDeployment.txHash)).toBe(true);
    const allCells = [oldCell, ...funds];
    const resolver = staticCellResolver(
      allCells.map((cell) => ({
        outPoint: cell.outPoint,
        cellOutput: cell.cellOutput,
        data: bytesFrom(cell.outputData),
      })),
    );
    const signed = await signer.signTransaction(tx, resolver);
    expect(signer.verifyOwnSignature(signed, resolveInOrder(tx, allCells))).toBe(true);
    expect(estimatedFee > 0n).toBe(true);
  });

  it("refuses to rotate a profile cell the signer does not own", async () => {
    const foreignLock = Script.from({
      codeHash: fixtureSigner.lockScript().codeHash,
      hashType: fixtureSigner.lockScript().hashType,
      args: `0x${"99".repeat(37)}`,
    });
    const oldCell = oldProfileCell(4000, 0xb2, foreignLock);
    const { signer } = makeSigner(oldCell, fundingCell(2000, 0xf4));
    await expect(
      buildRotateProfileTx({
        oldProfileCell: toWireCell(oldCell),
        newProfile: {
          ...codec.buildProfileMinimal(),
          rotation_sequence: 1,
          previous_profile_id: bytesFrom(OLD_TYPE_ARGS),
        },
        newLock: signer.lockScript(),
        signer,
      }),
    ).rejects.toThrow(/only the owner rotates/);
  });

  it("requires previous_profile_id to name the spent cell's type args", async () => {
    const oldCell = oldProfileCell(4000, 0xb3);
    const { signer } = makeSigner(oldCell, fundingCell(2000, 0xf5));
    await expect(
      buildRotateProfileTx({
        oldProfileCell: toWireCell(oldCell),
        newProfile: {
          ...codec.buildProfileMinimal(),
          rotation_sequence: 1,
          previous_profile_id: new Uint8Array(32),
        },
        newLock: signer.lockScript(),
        signer,
      }),
    ).rejects.toThrow(/previous_profile_id/);
  });
});

describe("buildRotateProfileTx capacity floor", () => {
  function wireCell(cell: Cell): WireCell {
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

  it("raises the successor's capacity to its occupied size when the new profile is bigger", async () => {
    // Old cell: minimal profile, exactly occupied-sized (small capacity).
    const oldCell = Cell.from({
      outPoint: { txHash: fill(0xb9, 32), index: 0 },
      cellOutput: toOutputLike(
        CellOutput.from({
          capacity: fixedPointFrom(200),
          lock: fixtureSigner.lockScript(),
          type: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: `0x${"ab".repeat(32)}` },
        }),
      ),
      outputData: "0x1234",
    });
    const funds = [fundingCell(5000, 0xf6)];
    const { signer } = makeSigner(oldCell, ...funds);
    const bigProfile = {
      ...codec.buildProfileBoundaries(), // 64-byte handle + 8 versions
      rotation_sequence: 1,
      previous_profile_id: bytesFrom(`0x${"ab".repeat(32)}`),
    };
    const oldCapacity = fixedPointFrom(200);

    const { tx } = await buildRotateProfileTx({
      oldProfileCell: wireCell(oldCell),
      newProfile: bigProfile,
      newLock: signer.lockScript(),
      signer,
    });
    const output = tx.outputs[0]!;
    // The successor must NOT stay at the old 200 CKB: its occupied size grew
    // (previous_profile_id + max handle), and capacity must cover it.
    expect(output.capacity > oldCapacity).toBe(true);
  });
});
