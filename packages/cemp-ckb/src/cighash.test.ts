import { CellOutput, Transaction, WitnessArgs } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import {
  MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN,
  buildCighashAllStream,
  buildPlaceholderWitness,
  withSignatureLock,
} from "./cighash.js";

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

describe("buildCighashAllStream golden vectors (tools/signing-harness)", () => {
  for (const cc of vectors.cighash) {
    it(`stream matches byte-for-byte (${cc.name})`, () => {
      const tx = Transaction.fromBytes(hexToBytes(cc.tx));
      const resolvedInputs = cc.resolvedInputs.map((ri) => ({
        cellOutput: CellOutput.fromBytes(hexToBytes(ri.cellOutput)),
        data: hexToBytes(ri.data),
      }));
      const stream = buildCighashAllStream(tx, resolvedInputs, [...cc.groupInputIndices]);
      expect(bytesToHex(stream)).toBe(cc.stream);
    });
  }

  it("rejects a resolved-input count mismatch", () => {
    const cc = vectors.cighash[0]!;
    const tx = Transaction.fromBytes(hexToBytes(cc.tx));
    expect(() => buildCighashAllStream(tx, [], [0])).toThrow(/resolved inputs/);
  });

  it("rejects an empty group", () => {
    const cc = vectors.cighash[0]!;
    const tx = Transaction.fromBytes(hexToBytes(cc.tx));
    const resolvedInputs = cc.resolvedInputs.map((ri) => ({
      cellOutput: CellOutput.fromBytes(hexToBytes(ri.cellOutput)),
      data: hexToBytes(ri.data),
    }));
    expect(() => buildCighashAllStream(tx, resolvedInputs, [])).toThrow(/empty group/);
  });

  it("rejects a group index past the witness count", () => {
    const cc = vectors.cighash[0]!;
    const tx = Transaction.fromBytes(hexToBytes(cc.tx));
    const resolvedInputs = cc.resolvedInputs.map((ri) => ({
      cellOutput: CellOutput.fromBytes(hexToBytes(ri.cellOutput)),
      data: hexToBytes(ri.data),
    }));
    expect(() => buildCighashAllStream(tx, resolvedInputs, [5])).toThrow(/out of range/);
  });

  it("rejects a non-WitnessArgs first group witness", () => {
    const cc = vectors.cighash[1]!; // has a raw-bytes extra witness
    const tx = Transaction.fromBytes(hexToBytes(cc.tx));
    const resolvedInputs = cc.resolvedInputs.map((ri) => ({
      cellOutput: CellOutput.fromBytes(hexToBytes(ri.cellOutput)),
      data: hexToBytes(ri.data),
    }));
    // Index 2 is the raw "extra-witness-payload", not a WitnessArgs molecule.
    expect(() => buildCighashAllStream(tx, resolvedInputs, [2])).toThrow(/WitnessArgs/);
  });
});

describe("witness helpers", () => {
  it("placeholder witness reserves 5262 zero bytes of lock", () => {
    const placeholder = buildPlaceholderWitness();
    expect(placeholder.lock).toBe(`0x${"00".repeat(MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN)}`);
    // Round-trips through molecule unchanged.
    expect(WitnessArgs.fromBytes(placeholder.toBytes()).lock).toBe(placeholder.lock);
  });

  it("withSignatureLock replaces only the lock field", () => {
    const witness = WitnessArgs.from({
      lock: `0x${"00".repeat(65)}`,
      inputType: "0x69742d7061796c6f6164",
      outputType: "0x6f742d7061796c6f6164",
    });
    const lockBytes = hexToBytes(`7b${"11".repeat(10)}`);
    const spliced = withSignatureLock(witness, lockBytes);
    expect(spliced.lock).toBe(`0x${bytesToHex(lockBytes)}`);
    expect(spliced.inputType).toBe(witness.inputType);
    expect(spliced.outputType).toBe(witness.outputType);
  });
});
