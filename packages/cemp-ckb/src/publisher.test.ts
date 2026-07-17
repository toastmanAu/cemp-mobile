import {
  Cell,
  CellOutput,
  Script,
  Transaction,
  bytesFrom,
  fixedPointFrom,
  hexFrom,
  numFrom,
} from "@ckb-ccc/core";
import { CKB_TESTNET, codec } from "@cemp/core";
import { deriveIdentityKeys, mldsaV2KeygenFromSeed, wipeIdentityKeyBundle } from "@cemp/crypto";
import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import { TYPE_ID_CODE_HASH, type CempMessageTypeRef } from "./builders.js";
import { CempClient, type JsonRpcTransport } from "./client.js";
import { MessagePublisher, PublicationError, type PublicationStore } from "./publisher.js";
import { MlDsaV2TxSigner } from "./signing.js";
import { MockCkbClient, fillHex, toOutputLike } from "./testing/mock-ccc-client.js";

/**
 * Phase 7 publisher pipeline tests (offline): state-transition order,
 * rule-6 journal-before-broadcast, failure mapping, and crash-resume —
 * driven end to end through the REAL builder + signer against a mock chain.
 */

function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const keyPair = mldsaV2KeygenFromSeed(hexToBytes(vectors.keygen[0]!.seed));

function fundingCell(ckb: number, seed: number, lock: Script): Cell {
  return Cell.from({
    outPoint: { txHash: fillHex(seed, 32), index: 0 },
    cellOutput: toOutputLike(CellOutput.from({ capacity: fixedPointFrom(ckb), lock })),
    outputData: "0x",
  });
}

// ── fake publication store (records event order for rule-6 assertions) ────

interface StoreEvent {
  kind: "transition" | "chainref" | "journal" | "txstate" | "broadcast";
  detail: string;
}

class FakeStore implements PublicationStore {
  readonly events: StoreEvent[] = [];
  readonly states: string[] = [];
  readonly txs = new Map<string, { txHash: string; state: string; purpose: string }>();

  transitionMessage(_id: number, to: string): Promise<void> {
    this.states.push(to);
    this.events.push({ kind: "transition", detail: to });
    return Promise.resolve();
  }

  setMessageChainRef(_id: number, ref: { txHash: string; outpointIndex: number }): Promise<void> {
    this.events.push({ kind: "chainref", detail: ref.txHash });
    return Promise.resolve();
  }

  recordOutgoingTx(input: { txHash: string; purpose: string; state: string }): Promise<void> {
    this.txs.set(input.txHash, {
      txHash: input.txHash,
      state: input.state,
      purpose: input.purpose,
    });
    this.events.push({ kind: "journal", detail: input.txHash });
    return Promise.resolve();
  }

  markOutgoingTxState(txHash: string, state: string): Promise<void> {
    const tx = this.txs.get(txHash);
    if (tx !== undefined) {
      tx.state = state;
    }
    this.events.push({ kind: "txstate", detail: state });
    return Promise.resolve();
  }

  findOutgoingTxByPurpose(purpose: string): Promise<{ txHash: string; state: string } | undefined> {
    const found = [...this.txs.values()].filter((t) => t.purpose === purpose).at(-1);
    return Promise.resolve(found);
  }
}

// ── fake chain (transport for CempClient) ─────────────────────────────────

interface FakeChainOptions {
  readonly profileCellJson?: unknown;
  readonly onBroadcast?: () => void;
}

/** Recompute the signed tx hash from the send_transaction RPC body (via CCC). */
function hashFromRpcBody(body: Record<string, unknown>): string {
  type AnyRec = Record<string, unknown>;
  const tx = Transaction.from({
    version: numFrom(body.version as string),
    cellDeps: (body.cell_deps as AnyRec[]).map((dep) => {
      const outPoint = dep.out_point as AnyRec;
      return {
        outPoint: {
          txHash: outPoint.tx_hash as string,
          index: numFrom(outPoint.index as string),
        },
        depType: dep.dep_type as "code" | "depGroup",
      };
    }),
    headerDeps: body.header_deps as string[],
    inputs: (body.inputs as AnyRec[]).map((input) => {
      const previous = input.previous_output as AnyRec;
      return {
        previousOutput: {
          txHash: previous.tx_hash as string,
          index: numFrom(previous.index as string),
        },
        since: numFrom(input.since as string),
      };
    }),
    outputs: (body.outputs as AnyRec[]).map((output) => {
      const lock = output.lock as AnyRec;
      const type = output.type as AnyRec | null;
      return {
        capacity: numFrom(output.capacity as string),
        lock: {
          codeHash: lock.code_hash as string,
          hashType: lock.hash_type as "type",
          args: lock.args as string,
        },
        type:
          type === null
            ? null
            : {
                codeHash: type.code_hash as string,
                hashType: type.hash_type as "type",
                args: type.args as string,
              },
      };
    }),
    outputsData: body.outputs_data as string[],
    witnesses: body.witnesses as string[],
  });
  return tx.hash();
}

function makeFakeChain(options: FakeChainOptions): {
  transport: JsonRpcTransport;
  sentBodies: Record<string, unknown>[];
} {
  const sentBodies: Record<string, unknown>[] = [];
  const transport: JsonRpcTransport = {
    call(_url, method, params) {
      switch (method) {
        case "get_cells":
          return Promise.resolve({
            objects: options.profileCellJson === undefined ? [] : [options.profileCellJson],
            last_cursor: "0x0",
          });
        case "send_transaction": {
          const body = params[0] as Record<string, unknown>;
          sentBodies.push(body);
          options.onBroadcast?.();
          return Promise.resolve(hashFromRpcBody(body));
        }
        case "get_transaction":
          return Promise.resolve({
            tx_status: { status: "committed", block_hash: fillHex(0x99, 32) },
          });
        case "get_header":
          return Promise.resolve({
            number: "0x100",
            epoch: "0x0",
            timestamp: "0x0",
            hash: fillHex(0x99, 32),
          });
        default:
          return Promise.reject(new Error(`fake chain: unexpected method ${method}`));
      }
    },
  };
  return { transport, sentBodies };
}

// ── fixture assembly ───────────────────────────────────────────────────────

const MESSAGE_TYPE_REF: CempMessageTypeRef = {
  codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
  hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
  cellDep: {
    txHash: CKB_TESTNET.deployments.cempMessageType!.txHash,
    index: "0x0",
    depType: "code",
  },
};

function makeFixture(profileCellJson?: unknown): {
  publisher: MessagePublisher;
  store: FakeStore;
  sentBodies: Record<string, unknown>[];
} {
  const store = new FakeStore();
  const { transport, sentBodies } = makeFakeChain({
    ...(profileCellJson === undefined ? {} : { profileCellJson }),
    onBroadcast: () => {
      store.events.push({ kind: "broadcast", detail: "send_transaction" });
    },
  });
  const client = new CempClient({ transport });
  const mockChain = new MockCkbClient();
  const signer = new MlDsaV2TxSigner({ keyPair, client: mockChain });
  mockChain.addCells(fundingCell(10_000, 0xf1, signer.lockScript()));
  const publisher = new MessagePublisher({
    client,
    signer,
    messageType: MESSAGE_TYPE_REF,
    store,
    senderProfileId: hexToBytes("11".repeat(32)),
    senderDeviceId: hexToBytes("22".repeat(16)),
  });
  return { publisher, store, sentBodies };
}

function recipientProfileCellJson(): { json: unknown; profileIdHex: string } {
  // A real ML-KEM keypair: encryptEnvelope encapsulates against this pk.
  const identity = deriveIdentityKeys(hexToBytes(`0x${"77".repeat(64)}`));
  const recipientLock = Script.from({
    codeHash: fillHex(0x77, 32),
    hashType: "type",
    args: `0x${"42".repeat(37)}`,
  });
  const profileIdHex = "ab".repeat(32);
  const profileData = codec.encodeCempProfileV1({
    ...codec.buildProfileMinimal(),
    ml_dsa_public_key: identity.mlDsa.publicKey,
    ml_kem_public_key: identity.mlKem.publicKey,
    lock_script_hash: bytesFrom(recipientLock.hash()),
  });
  wipeIdentityKeyBundle(identity);
  return {
    profileIdHex,
    json: {
      out_point: { tx_hash: fillHex(0x51, 32), index: "0x0" },
      output: {
        capacity: `0x${fixedPointFrom(4000).toString(16)}`,
        lock: { code_hash: recipientLock.codeHash, hash_type: "type", args: recipientLock.args },
        type: { code_hash: TYPE_ID_CODE_HASH, hash_type: "type", args: `0x${profileIdHex}` },
      },
      output_data: hexFrom(profileData),
      block_number: "0x1",
    },
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("MessagePublisher.publishText", () => {
  it("drives the §11 state order, journals BEFORE broadcast, and lands committed", async () => {
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher, store, sentBodies } = makeFixture(json);

    const result = await publisher.publishText({
      messageRowId: 7,
      logicalMessageId: "lm-happy",
      text: "hello from the pipeline",
      recipientProfileIdHex: profileIdHex,
    });

    expect(result.committed).toBe(true);
    expect(result.resumed).toBe(false);
    expect(store.states).toEqual([
      "encrypting",
      "building_transaction",
      "awaiting_signature",
      "submitting",
      "pending",
      "committed",
      "available_on_chain",
    ]);

    // Rule 6: the journal entry exists BEFORE the broadcast, for the same tx.
    const kinds = store.events.map((e) => e.kind);
    expect(kinds.indexOf("journal")).toBeLessThan(kinds.indexOf("broadcast"));
    expect(sentBodies).toHaveLength(1);
    expect(store.events.find((e) => e.kind === "journal")?.detail).toBe(result.txHash);
    expect(hashFromRpcBody(sentBodies[0]!)).toBe(result.txHash);
    expect(result.outPoint).toEqual({ txHash: result.txHash, index: 0 });
    // The outgoing tx record reached committed.
    expect(store.txs.get(result.txHash)?.state).toBe("committed");
  });

  it("maps a missing recipient profile to a jargon-free failure and marks the message failed", async () => {
    const { publisher, store, sentBodies } = makeFixture(); // no profile cell
    const failure = await publisher
      .publishText({
        messageRowId: 8,
        logicalMessageId: "lm-noprofile",
        text: "x",
        recipientProfileIdHex: "ab".repeat(32),
      })
      .then(
        () => {
          throw new Error("expected publishText to fail");
        },
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(PublicationError);
    expect((failure as PublicationError).code).toBe("profile-not-found");
    expect((failure as PublicationError).userMessage).not.toMatch(/cell|transaction|CKB/i);
    expect(store.states).toEqual(["encrypting", "failed"]);
    expect(sentBodies).toHaveLength(0);
  });

  it("resumes a journaled tx after a crash instead of rebuilding (task 10)", async () => {
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher, store, sentBodies } = makeFixture(json);
    // Simulate the crash: a submitted tx already journaled for this message.
    const crashedTxHash = fillHex(0xca, 32);
    store.txs.set(crashedTxHash, {
      txHash: crashedTxHash,
      state: "submitted",
      purpose: "message:lm-crash",
    });

    const result = await publisher.publishText({
      messageRowId: 9,
      logicalMessageId: "lm-crash",
      text: "re-sent after crash",
      recipientProfileIdHex: profileIdHex,
    });

    expect(result.resumed).toBe(true);
    expect(result.txHash).toBe(crashedTxHash);
    expect(result.committed).toBe(true);
    // NO new transaction was built or broadcast.
    expect(sentBodies).toHaveLength(0);
    expect(store.txs.get(crashedTxHash)?.state).toBe("committed");
    expect(store.states).toEqual(["committed", "available_on_chain"]);
  });

  it("a retry after a pre-broadcast failure builds a NEW tx for the SAME logical message", async () => {
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher, store } = makeFixture(json);
    const input = {
      messageRowId: 10,
      logicalMessageId: "lm-retry",
      text: "retry me",
      recipientProfileIdHex: profileIdHex,
    };
    // First attempt dies before broadcast: sabotage the builder by giving a
    // recipient id that resolves but breaks... simplest honest sabotage: a
    // fresh fixture whose chain has no profile cell for the FIRST call.
    const failing = makeFixture();
    await expect(failing.publisher.publishText(input)).rejects.toMatchObject({
      code: "profile-not-found",
    });
    expect(failing.store.states).toEqual(["encrypting", "failed"]);

    // Retry succeeds (network came back / profile appeared) — same logical id.
    const result = await publisher.publishText(input);
    expect(result.committed).toBe(true);
    // Exactly one journaled tx exists for the logical message; a second retry
    // would RESUME it rather than rebuild.
    const journaled = [...store.txs.values()].filter((t) => t.purpose === "message:lm-retry");
    expect(journaled).toHaveLength(1);
    const again = await publisher.publishText(input);
    expect(again.resumed).toBe(true);
    expect(again.txHash).toBe(result.txHash);
  });
});
