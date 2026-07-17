import { describe, expect, it } from "vitest";
import { CempCkbError, CempClient, transactionToRpc } from "./client.js";
import type { JsonRpcTransport } from "./client.js";
import type { Transaction } from "./types.js";

function fill(byte: number, length: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(length)}`;
}

/** Minimal well-formed signed-transaction-shaped object (types.ts shape). */
function sampleTx(): Transaction {
  return {
    version: "0x0",
    cellDeps: [
      {
        outPoint: { txHash: fill(0x11, 32), index: "0x3" },
        depType: "code",
      },
    ],
    headerDeps: [],
    inputs: [
      {
        previousOutput: { txHash: fill(0x22, 32), index: "0x0" },
        since: "0x0",
      },
    ],
    outputs: [
      {
        capacity: "0x2540be400",
        lock: { codeHash: fill(0x33, 32), hashType: "type", args: "0x0102" },
        type: null,
      },
    ],
    outputsData: ["0x"],
    witnesses: ["0x10000000100000001000000010000000"],
  };
}

describe("transactionToRpc", () => {
  it("emits the snake_case send_transaction wire body", () => {
    expect(transactionToRpc(sampleTx())).toEqual({
      version: "0x0",
      cell_deps: [
        {
          out_point: { tx_hash: fill(0x11, 32), index: "0x3" },
          dep_type: "code",
        },
      ],
      header_deps: [],
      inputs: [
        {
          previous_output: { tx_hash: fill(0x22, 32), index: "0x0" },
          since: "0x0",
        },
      ],
      outputs: [
        {
          capacity: "0x2540be400",
          lock: { code_hash: fill(0x33, 32), hash_type: "type", args: "0x0102" },
          type: null,
        },
      ],
      outputs_data: ["0x"],
      witnesses: ["0x10000000100000001000000010000000"],
    });
  });

  it("rejects malformed fields before anything leaves the process", () => {
    const badIndex = sampleTx();
    badIndex.inputs[0]!.previousOutput.index = "0x100000000"; // > uint32
    expect(() => transactionToRpc(badIndex)).toThrow(CempCkbError);

    const badHash = sampleTx();
    badHash.cellDeps[0]!.outPoint.txHash = "0x1234";
    expect(() => transactionToRpc(badHash)).toThrow(/32-byte hash/);

    const mismatched = sampleTx();
    mismatched.outputsData = [];
    expect(() => transactionToRpc(mismatched)).toThrow(/length mismatch/);

    const badWitness = sampleTx();
    badWitness.witnesses = ["not-hex"];
    expect(() => transactionToRpc(badWitness)).toThrow(CempCkbError);
  });
});

describe("CempClient.sendTransaction", () => {
  function mockTransport(
    captured: { method?: string; params?: unknown[] },
    result: unknown,
  ): JsonRpcTransport {
    return {
      call(_url, method, params) {
        captured.method = method;
        captured.params = params;
        return Promise.resolve(result);
      },
    };
  }

  it("sends the validated wire body with the passthrough outputs validator", async () => {
    const txHash = fill(0xab, 32);
    const captured: { method?: string; params?: unknown[] } = {};
    const client = new CempClient({ transport: mockTransport(captured, txHash) });

    const hash = await client.sendTransaction(sampleTx());

    expect(hash).toBe(txHash);
    expect(captured.method).toBe("send_transaction");
    expect(captured.params!.length).toBe(2);
    expect(captured.params![0]).toEqual(transactionToRpc(sampleTx()));
    // CEMP scripts are not well-known to the node: passthrough is required.
    expect(captured.params![1]).toBe("passthrough");
  });

  it("validates the response hash (rule 4)", async () => {
    const client = new CempClient({ transport: mockTransport({}, "0x1234") });
    await expect(client.sendTransaction(sampleTx())).rejects.toThrow(/32-byte hash/);
  });
});
