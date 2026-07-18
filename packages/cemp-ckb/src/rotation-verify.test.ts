import { Cell, CellOutput, fixedPointFrom } from "@ckb-ccc/core";
import { CKB_TESTNET, codec } from "@cemp/core";
import { describe, expect, it } from "vitest";
import { CempClient, type JsonRpcTransport } from "./client.js";
import { TYPE_ID_CODE_HASH } from "./builders.js";
import { verifyRotationChainOnChain, verifyRotationLinkOnChain } from "./rotation-verify.js";
import { fillHex } from "./testing/mock-ccc-client.js";

/**
 * Review Finding A: a forged rotation link (self-declared back-reference,
 * wrong creating tx) must FAIL, an honest one must PASS.
 */
function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const OLD_PROFILE_ID = "ab".repeat(32);
const NEW_PROFILE_ID = "cd".repeat(32);
const OLD_OUTPOINT = { txHash: fillHex(0xa1, 32), index: "0x0" };
const CREATE_TX_HASH = fillHex(0xb2, 32);

function successorResolved(consumedOld: boolean) {
  const newProfile = codec.encodeCempProfileV1({
    ...codec.buildProfileMinimal(),
    rotation_sequence: 1,
    previous_profile_id: hexToBytes(OLD_PROFILE_ID),
  });
  return {
    consumedOld,
    resolved: {
      cell: {
        outPoint: { txHash: CREATE_TX_HASH, index: "0x0" },
        output: {
          capacity: `0x${fixedPointFrom(3409).toString(16)}`,
          lock: {
            codeHash: fillHex(0x77, 32),
            hashType: "type" as const,
            args: `0x${"42".repeat(37)}`,
          },
          type: {
            codeHash: TYPE_ID_CODE_HASH,
            hashType: "type" as const,
            args: `0x${NEW_PROFILE_ID}`,
          },
        },
        data: `0x${Array.from(newProfile, (b) => b.toString(16).padStart(2, "0")).join("")}`,
        blockNumber: "0x1",
      },
      profile: codec.decodeCempProfileV1(newProfile),
    },
  };
}

function makeClient(opts: { creatingTxInputs: { txHash: string; index: string }[] }): CempClient {
  const transport: JsonRpcTransport = {
    call(_url, method, params) {
      if (method === "get_transaction") {
        return Promise.resolve({
          transaction: {
            version: "0x0",
            cell_deps: [],
            header_deps: [],
            inputs: opts.creatingTxInputs.map((input) => ({
              previous_output: { tx_hash: input.txHash, index: input.index },
              since: "0x0",
            })),
            outputs: [],
            outputs_data: [],
            witnesses: [],
          },
          tx_status: { status: "committed", block_hash: fillHex(0x99, 32) },
        });
      }
      return Promise.reject(new Error(`unexpected ${method} ${JSON.stringify(params)}`));
    },
  };
  return new CempClient({ transport });
}

describe("verifyRotationLinkOnChain (review Finding A)", () => {
  const predecessor = { outPoint: OLD_OUTPOINT, profileIdHex: `0x${OLD_PROFILE_ID}` };

  it("accepts an honest link: the creating tx consumed the predecessor outpoint", async () => {
    const client = makeClient({ creatingTxInputs: [OLD_OUTPOINT] });
    const { resolved } = successorResolved(true);
    await expect(verifyRotationLinkOnChain(client, predecessor, resolved)).resolves.toBeUndefined();
  });

  it("rejects a forged link: the creating tx consumed some other input", async () => {
    const client = makeClient({ creatingTxInputs: [{ txHash: fillHex(0xee, 32), index: "0x0" }] });
    const { resolved } = successorResolved(false);
    await expect(verifyRotationLinkOnChain(client, predecessor, resolved)).rejects.toThrow(
      /did not consume/,
    );
  });

  it("rejects a forged back-reference even when the outpoint matches", async () => {
    const client = makeClient({ creatingTxInputs: [OLD_OUTPOINT] });
    const { resolved } = successorResolved(true);
    const forged = {
      outPoint: { txHash: fillHex(0xa1, 32), index: "0x0" },
      profileIdHex: `0x${"99".repeat(32)}`, // claims a DIFFERENT predecessor id
    };
    await expect(verifyRotationLinkOnChain(client, forged, resolved)).rejects.toThrow(
      /does not name the consumed predecessor/,
    );
  });

  it("verifyRotationChainOnChain fails an empty chain and a bad link", async () => {
    const client = makeClient({ creatingTxInputs: [OLD_OUTPOINT] });
    await expect(verifyRotationChainOnChain(client, [])).rejects.toThrow(/empty/);
    const { resolved } = successorResolved(false);
    const badClient = makeClient({
      creatingTxInputs: [{ txHash: fillHex(0xee, 32), index: "0x0" }],
    });
    await expect(
      verifyRotationChainOnChain(badClient, [{ predecessor, successor: resolved }]),
    ).rejects.toThrow(/link 0 failed/);
  });

  void Cell;
  void CellOutput;
  void CKB_TESTNET;
});
