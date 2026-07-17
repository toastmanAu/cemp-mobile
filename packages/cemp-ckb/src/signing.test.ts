import {
  CellOutput,
  ClientPublicTestnet,
  OutPoint,
  Transaction,
  WitnessArgs,
  bytesFrom,
  fixedPointFrom,
} from "@ckb-ccc/core";
import { mldsaV2KeygenFromSeed } from "@cemp/crypto";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import { MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN, buildCighashAllStream } from "./cighash.js";
import { MlDsaV2TxSigner, staticCellResolver } from "./signing.js";
import type { CellResolver } from "./signing.js";
import type { ResolvedInput } from "./cighash.js";

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

function u32le(length: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, length, true);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Golden keypair from the public vector file (test-only material).
const keygen = vectors.keygen[0]!;
const keyPair = mldsaV2KeygenFromSeed(hexToBytes(keygen.seed));

// Never contacted: every test signs against an injected CellResolver.
const offlineClient = new ClientPublicTestnet({ url: "http://127.0.0.1:9/" });
const signer = new MlDsaV2TxSigner({ keyPair, client: offlineClient });

interface SyntheticTx {
  tx: Transaction;
  fundingOutput: CellOutput;
  resolvedInputs: ResolvedInput[];
  resolver: CellResolver;
}

function makeSyntheticTx(inputCount: number): SyntheticTx {
  const lock = signer.lockScript();
  const fundingOutput = CellOutput.from({ capacity: fixedPointFrom(1000), lock });
  const inputs = [];
  const cells = [];
  for (let i = 0; i < inputCount; i++) {
    const outPoint = OutPoint.from({
      txHash: `0x${(i + 17).toString(16).padStart(64, "0")}`,
      index: i,
    });
    inputs.push({ previousOutput: outPoint });
    cells.push({ outPoint, cellOutput: fundingOutput, data: new Uint8Array(0) });
  }
  const tx = Transaction.from({
    inputs,
    outputs: [{ capacity: fixedPointFrom(900), lock }],
    outputsData: ["0x"],
  });
  const resolvedInputs = cells.map((cell) => ({
    cellOutput: cell.cellOutput,
    data: cell.data,
  }));
  return { tx, fundingOutput, resolvedInputs, resolver: staticCellResolver(cells) };
}

describe("MlDsaV2TxSigner construction", () => {
  it("derives the golden keypair from the vector seed", () => {
    expect(bytesToHex(keyPair.publicKey)).toBe(keygen.pubkey);
    expect(bytesToHex(keyPair.secretKey)).toBe(keygen.secretKey);
  });

  it("lock script uses the golden v2 lock args and the network deployment", () => {
    const lock = signer.lockScript();
    expect(lock.args).toBe(`0x${keygen.lockArgs}`);
    expect(lock.args.length).toBe(2 + 37 * 2);
    expect(lock.codeHash).toBe(signer.network.deployments.mlDsaLock!.codeHash);
    expect(lock.hashType).toBe(signer.network.deployments.mlDsaLock!.hashType);
  });
});

describe("MlDsaV2TxSigner.signTransaction (offline, mock CellResolver)", () => {
  it("splices a 5262-byte witness lock starting with 0x7B", async () => {
    const { tx, resolver } = makeSyntheticTx(1);
    const signed = await signer.signTransaction(tx, resolver);
    expect(signed.witnesses.length).toBe(1);
    const witness = WitnessArgs.fromBytes(bytesFrom(signed.witnesses[0]!));
    expect(witness.lock).toBeDefined();
    const lock = bytesFrom(witness.lock!);
    expect(lock.length).toBe(5262);
    expect(lock[0]).toBe(0x7b);
    // The public key rides inside the witness lock.
    expect(bytesToHex(lock.subarray(1, 1 + 1952))).toBe(keygen.pubkey);
  });

  it("does not change the tx hash (witnesses are not covered by it)", async () => {
    const { tx, resolver } = makeSyntheticTx(1);
    // A fully prepared tx (cell dep + placeholders) — signing must not touch the hash.
    const prepared = await signer.prepareTransaction(tx);
    const before = prepared.hash();
    const signed = await signer.signTransaction(prepared, resolver);
    expect(signed.hash()).toBe(before);
  });

  it("verifyOwnSignature passes on the signed tx", async () => {
    const { tx, resolvedInputs, resolver } = makeSyntheticTx(1);
    const signed = await signer.signTransaction(tx, resolver);
    expect(signer.verifyOwnSignature(signed, resolvedInputs)).toBe(true);
  });

  it("verifyOwnSignature fails after tampering with an output", async () => {
    const { tx, resolvedInputs, resolver } = makeSyntheticTx(1);
    const signed = await signer.signTransaction(tx, resolver);
    const tampered = Transaction.fromBytes(signed.toBytes());
    tampered.outputs[0]!.capacity += 1n;
    expect(signer.verifyOwnSignature(tampered, resolvedInputs)).toBe(false);
  });

  it("verifyOwnSignature fails for an unsigned (placeholder) witness", () => {
    const { tx, resolvedInputs } = makeSyntheticTx(1);
    tx.setWitnessArgsAt(
      0,
      WitnessArgs.from({ lock: `0x${"00".repeat(MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN)}` }),
    );
    expect(signer.verifyOwnSignature(tx, resolvedInputs)).toBe(false);
  });

  it("rebuilds the exact cighash stream from the signed tx", async () => {
    const { tx, fundingOutput, resolvedInputs, resolver } = makeSyntheticTx(1);
    const signed = await signer.signTransaction(tx, resolver);
    const stream = buildCighashAllStream(signed, resolvedInputs, [0]);
    // Manual rebuild: tx_hash ‖ cell_output ‖ u32le(0) (empty data)
    // ‖ u32le(0) (input_type BytesOpt slice) ‖ u32le(0) (output_type slice).
    const expected = concat(
      bytesFrom(signed.hash()),
      fundingOutput.toBytes(),
      u32le(0),
      u32le(0),
      u32le(0),
    );
    expect(bytesToHex(stream)).toBe(bytesToHex(expected));
  });

  it("signs a 2-input group: placeholder in witness 1, fields preserved in witness 0", async () => {
    const { tx, resolvedInputs, resolver } = makeSyntheticTx(2);
    tx.setWitnessArgsAt(0, WitnessArgs.from({ inputType: "0x1234" }));
    const prepared = await signer.prepareTransaction(tx);
    const before = prepared.hash();
    const signed = await signer.signTransaction(prepared, resolver);

    expect(signed.witnesses.length).toBe(2);
    const witness0 = WitnessArgs.fromBytes(bytesFrom(signed.witnesses[0]!));
    expect(bytesFrom(witness0.lock!).length).toBe(5262);
    expect(bytesFrom(witness0.lock!)[0]).toBe(0x7b);
    expect(witness0.inputType).toBe("0x1234");

    // The non-first group witness keeps its placeholder lock; it is streamed
    // in full by the v2 construction and verifies as-is on-chain.
    const witness1 = WitnessArgs.fromBytes(bytesFrom(signed.witnesses[1]!));
    const lock1 = bytesFrom(witness1.lock!);
    expect(lock1.length).toBe(MLDSA_V2_WITNESS_LOCK_PLACEHOLDER_LEN);
    expect(lock1.every((byte) => byte === 0)).toBe(true);

    expect(signed.hash()).toBe(before);
    expect(signer.verifyOwnSignature(signed, resolvedInputs)).toBe(true);
  });

  it("rejects signing when an input cannot be resolved", async () => {
    const { tx } = makeSyntheticTx(1);
    await expect(signer.signTransaction(tx, staticCellResolver([]))).rejects.toThrow(
      /not a live cell/,
    );
  });
});
