import { Cell, CellOutput, Script, bytesFrom, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET, codec } from "@cemp/core";
import { deriveIdentityKeys, mldsaV2KeygenFromSeed, wipeIdentityKeyBundle } from "@cemp/crypto";
import { describe, expect, it, vi } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import type { AssembleTextMessageParams } from "./assemble.js";
import { TYPE_ID_CODE_HASH, type CempMessageTypeRef } from "./builders.js";
import { CempClient, type JsonRpcTransport } from "./client.js";
import { MlDsaV2TxSigner } from "./signing.js";
import { MockCkbClient, fillHex, toOutputLike } from "./testing/mock-ccc-client.js";
import { hashFromRpcBody } from "./testing/rpc-body.js";

// Capture what publishText passes to assembleTextMessage, while still running
// the real implementation underneath (so the rest of this file's end-to-end
// pipeline assertions keep exercising real assembly/encryption).
const mockAssembleSpy = vi.fn();
vi.mock("./assemble.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assemble.js")>();
  return {
    ...actual,
    assembleTextMessage: (params: AssembleTextMessageParams) => {
      mockAssembleSpy(params);
      return actual.assembleTextMessage(params);
    },
  };
});

// NOTE: MessagePublisher must be imported AFTER vi.mock("./assemble.js") is
// registered above (Vitest hoists the vi.mock call, but the import ordering
// here keeps the dependency explicit for readers).
import { MessagePublisher, PublicationError, type PublicationStore } from "./publisher.js";

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

/** `tx_hash:index` of every input in a broadcast wire body. */
function inputKeys(body: Record<string, unknown>): string[] {
  const inputs =
    (body as { inputs?: { previous_output?: { tx_hash?: string; index?: string } }[] }).inputs ??
    [];
  return inputs.map(
    (input) => `${String(input.previous_output?.tx_hash)}:${String(input.previous_output?.index)}`,
  );
}

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

/**
 * The §11 outgoing transition table, mirrored from cemp-database's
 * message-states (cemp-ckb cannot depend on cemp-database, so the small
 * table is reimplemented here). The fake store ENFORCES it — a regression
 * like review C-1 (resume jumping queued → committed, which has no edge)
 * fails these tests instead of wedging silently.
 */
const OUTGOING_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ["queued", "failed"],
  queued: ["encrypting", "failed", "expired"],
  encrypting: ["building_transaction", "failed"],
  building_transaction: ["awaiting_signature", "failed"],
  awaiting_signature: ["submitting", "failed"],
  submitting: ["pending", "failed"],
  pending: ["committed", "failed", "expired"],
  committed: ["available_on_chain", "failed"],
  available_on_chain: ["downloaded_by_recipient", "failed"],
  downloaded_by_recipient: ["acknowledged", "failed"],
  acknowledged: ["reclaim_queued", "failed"],
  reclaim_queued: ["reclaim_pending", "failed"],
  reclaim_pending: ["reclaimed", "reclaim_queued", "failed"],
  reclaimed: [],
  expired: [],
  failed: ["queued"],
};

class FakeStore implements PublicationStore {
  readonly events: StoreEvent[] = [];
  readonly states: string[] = [];
  readonly txs = new Map<string, { txHash: string; state: string; purpose: string }>();
  /** Per-row §11 state — the composer hands publishText a queued row. */
  readonly rowStates = new Map<number, string>();

  #stateOf(id: number): string {
    return this.rowStates.get(id) ?? "queued";
  }

  transitionMessage(id: number, to: string): Promise<void> {
    const current = this.#stateOf(id);
    if (to !== current) {
      // Same-state is an idempotent no-op (§11); anything else must be a
      // legal edge, exactly like MessageRepository.transitionState.
      if (!OUTGOING_TRANSITIONS[current]?.includes(to)) {
        throw new Error(`illegal transition ${current} → ${to}`);
      }
      this.rowStates.set(id, to);
    }
    this.states.push(to);
    this.events.push({ kind: "transition", detail: to });
    return Promise.resolve();
  }

  getMessageState(id: number): Promise<string | undefined> {
    return Promise.resolve(this.#stateOf(id));
  }

  setMessageChainRef(_id: number, ref: { txHash: string; outpointIndex: number }): Promise<void> {
    this.events.push({ kind: "chainref", detail: ref.txHash });
    return Promise.resolve();
  }

  setEnvelopeMessageId(_id: number, envelopeMessageIdHex: string): Promise<void> {
    this.events.push({ kind: "chainref", detail: `envelope:${envelopeMessageIdHex}` });
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

  reserveCapacity(amount: string): Promise<void> {
    this.events.push({ kind: "txstate", detail: `reserve:${amount}` });
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

  findOutgoingTxByPurpose(
    purpose: string,
  ): Promise<
    | { txHash: string; state: string; txHex: string | null; capacityShannon: string | null }
    | undefined
  > {
    const found = [...this.txs.values()].filter((t) => t.purpose === purpose).at(-1);
    return Promise.resolve(
      found === undefined
        ? undefined
        : { txHash: found.txHash, state: found.state, txHex: null, capacityShannon: null },
    );
  }
}

// ── fake chain (transport for CempClient) ─────────────────────────────────

interface FakeChainOptions {
  readonly profileCellJson?: unknown;
  readonly onBroadcast?: () => void;
  readonly rejectedTxHashes?: ReadonlySet<string>;
  /** Every tx stays in the mempool forever (commit-timeout tests). */
  readonly neverCommit?: boolean;
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
        case "get_transaction": {
          const hash = params[0] as string;
          if (options.rejectedTxHashes?.has(hash)) {
            return Promise.resolve({
              tx_status: { status: "rejected", reason: "Resolve failed Unknown(OutPoint)" },
            });
          }
          if (options.neverCommit === true) {
            return Promise.resolve({ tx_status: { status: "pending" } });
          }
          return Promise.resolve({
            tx_status: { status: "committed", block_hash: fillHex(0x99, 32) },
          });
        }
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

function makeFixture(
  profileCellJson?: unknown,
  opts: {
    rejectedTxHashes?: ReadonlySet<string>;
    neverCommit?: boolean;
    senderProfileId?: () => Promise<Uint8Array>;
  } = {},
): {
  publisher: MessagePublisher;
  store: FakeStore;
  sentBodies: Record<string, unknown>[];
  mockChain: MockCkbClient;
} {
  const store = new FakeStore();
  const { transport, sentBodies } = makeFakeChain({
    ...(profileCellJson === undefined ? {} : { profileCellJson }),
    ...(opts.rejectedTxHashes === undefined ? {} : { rejectedTxHashes: opts.rejectedTxHashes }),
    ...(opts.neverCommit === undefined ? {} : { neverCommit: opts.neverCommit }),
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
    senderProfileId: opts.senderProfileId ?? (() => Promise.resolve(hexToBytes("11".repeat(32)))),
    senderDeviceId: hexToBytes("22".repeat(16)),
  });
  return { publisher, store, sentBodies, mockChain };
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
    // Pre-broadcast failure: the broadcast flag is false and the row IS failed.
    expect((failure as PublicationError).broadcast).toBe(false);
    expect((failure as PublicationError).userMessage).not.toMatch(/cell|transaction|CKB/i);
    expect(store.states).toEqual(["encrypting", "failed"]);
    expect(sentBodies).toHaveLength(0);
  });

  it("flags a post-broadcast failure (commit timeout) and does NOT mark the row failed (C-2)", async () => {
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher, store, sentBodies } = makeFixture(json, { neverCommit: true });

    const failure = await publisher
      .publishText({
        messageRowId: 13,
        logicalMessageId: "lm-timeout",
        text: "still pending",
        recipientProfileIdHex: profileIdHex,
        timeoutMs: 50,
      })
      .then(
        () => {
          throw new Error("expected publishText to fail");
        },
        (e: unknown) => e,
      );

    expect(failure).toBeInstanceOf(PublicationError);
    expect((failure as PublicationError).code).toBe("commit-timeout");
    // The tx WAS broadcast — the UI can tell this apart from a send failure.
    expect((failure as PublicationError).broadcast).toBe(true);
    expect(sentBodies).toHaveLength(1);
    // The row is legitimately in flight, NOT failed — the resume path picks
    // it up on the next call.
    expect(store.states).not.toContain("failed");
    expect(store.rowStates.get(13)).toBe("pending");
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
    // Review C-1: the resume walks the row through the LEGAL §11 path from
    // its current state (queued) to available_on_chain — never a direct
    // queued → committed jump (that edge does not exist and wedged the row).
    expect(store.states).toEqual([
      "encrypting",
      "building_transaction",
      "awaiting_signature",
      "submitting",
      "pending",
      "committed",
      "available_on_chain",
    ]);
  });

  it("resumes a row requeued by the UI retry (failed → queued) through the legal path (C-1)", async () => {
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher, store, sentBodies } = makeFixture(json);
    // A pre-broadcast failure marked the row failed; the user retried, taking
    // the §11 retry edge failed → queued — while the journaled tx was still
    // submitted (crash between journal and monitor).
    store.rowStates.set(12, "failed");
    await store.transitionMessage(12, "queued");
    store.states.length = 0; // the assertions below cover the publish walk only
    const crashedTxHash = fillHex(0xcb, 32);
    store.txs.set(crashedTxHash, {
      txHash: crashedTxHash,
      state: "submitted",
      purpose: "message:lm-requeued",
    });

    const result = await publisher.publishText({
      messageRowId: 12,
      logicalMessageId: "lm-requeued",
      text: "retried after failure",
      recipientProfileIdHex: profileIdHex,
    });

    expect(result.resumed).toBe(true);
    expect(result.committed).toBe(true);
    expect(sentBodies).toHaveLength(0);
    // Every step is a legal §11 edge, end to end (the FakeStore enforces the
    // state machine, so an illegal jump would have thrown above).
    expect(store.states).toEqual([
      "encrypting",
      "building_transaction",
      "awaiting_signature",
      "submitting",
      "pending",
      "committed",
      "available_on_chain",
    ]);
    expect(store.rowStates.get(12)).toBe("available_on_chain");
  });

  it("abandons a rejected journaled tx and rebuilds fresh for the same logical message (T17 F-1)", async () => {
    const { json, profileIdHex } = recipientProfileCellJson();
    const rejectedHash = fillHex(0xde, 32);
    const { publisher, store, sentBodies } = makeFixture(json, {
      rejectedTxHashes: new Set([rejectedHash]),
    });
    // The wedged state T17 hit on-device: a submitted message tx the network
    // rejected (built over an input its own chunk tx had just spent).
    store.txs.set(rejectedHash, {
      txHash: rejectedHash,
      state: "submitted",
      purpose: "message:lm-wedged",
    });

    const result = await publisher.publishText({
      messageRowId: 11,
      logicalMessageId: "lm-wedged",
      text: "wedged retry",
      recipientProfileIdHex: profileIdHex,
    });

    expect(result.committed).toBe(true);
    expect(result.resumed).toBe(false);
    expect(result.txHash).not.toBe(rejectedHash);
    // The dead tx is abandoned (never rebroadcast); exactly one NEW tx was
    // built and broadcast for the same logical message.
    expect(store.txs.get(rejectedHash)?.state).toBe("abandoned");
    expect(sentBodies).toHaveLength(1);
    const journaled = [...store.txs.values()].filter((t) => t.purpose === "message:lm-wedged");
    expect(journaled).toHaveLength(2);
    expect(journaled.find((t) => t.txHash !== rejectedHash)?.state).toBe("committed");
    // And a subsequent call resumes the FRESH tx rather than rebuilding again.
    const again = await publisher.publishText({
      messageRowId: 11,
      logicalMessageId: "lm-wedged",
      text: "wedged retry",
      recipientProfileIdHex: profileIdHex,
    });
    expect(again.resumed).toBe(true);
    expect(again.txHash).toBe(result.txHash);
    expect(sentBodies).toHaveLength(1);
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

  it("does not re-spend inputs consumed by a previous, still-unconfirmed publish", async () => {
    // Coin selection (completeInputsByCapacity) resolves live cells through the
    // signer's CCC client, which filters on `cache.isUnusable`. CCC only marks
    // that cache inside its OWN client.sendTransaction — we broadcast through
    // CempClient, so without an explicit mark the second message re-selects the
    // input the first one just spent and is dropped as a double-spend. Found
    // live: consecutive sends showed "sent" but never committed.
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher, sentBodies } = makeFixture(json);

    await publisher.publishText({
      messageRowId: 21,
      logicalMessageId: "lm-spend-a",
      text: "first",
      recipientProfileIdHex: profileIdHex,
    });
    await publisher.publishText({
      messageRowId: 22,
      logicalMessageId: "lm-spend-b",
      text: "second",
      recipientProfileIdHex: profileIdHex,
    });

    expect(sentBodies).toHaveLength(2);
    const spent = new Set(inputKeys(sentBodies[0]!));
    const reused = inputKeys(sentBodies[1]!).filter((key) => spent.has(key));
    expect(reused).toEqual([]);
  });
});

/**
 * Regression coverage for the device-reported bug: a freshly-set-up device
 * published its profile and sent a message IN THE SAME SESSION, and the
 * envelope's sender profile id was 32 zero bytes — `senderProfileId` had
 * been captured once at `MessagePublisher` construction time and never
 * refreshed. The fix removes the cache: `senderProfileId` is now a provider
 * function the publisher calls fresh on every `publishText`, and it must
 * reject (never fabricate a zero id) when no profile exists yet.
 */
describe("MessagePublisher sender profile id (fresh lookup, no cache — device bug regression)", () => {
  it("re-resolves the sender profile id on every publish, so a profile published mid-session is used immediately", async () => {
    mockAssembleSpy.mockClear();
    const { json, profileIdHex } = recipientProfileCellJson();
    // Simulates the device scenario: BEFORE publishMyProfile runs, the
    // repository has no active row — the provider naturally reflects that as
    // whatever value the caller currently holds. Here it starts as a
    // placeholder distinct from the real id, then flips to the real id
    // exactly like a profile getting published between two sends.
    let current = hexToBytes("00".repeat(32));
    const { publisher, sentBodies } = makeFixture(json, {
      senderProfileId: () => Promise.resolve(current),
    });

    await publisher.publishText({
      messageRowId: 30,
      logicalMessageId: "lm-sender-id-before",
      text: "first",
      recipientProfileIdHex: profileIdHex,
    });
    expect(mockAssembleSpy).toHaveBeenCalledTimes(1);
    expect(Array.from(mockAssembleSpy.mock.calls[0]![0].senderProfileId)).toEqual(
      Array.from(current),
    );

    // The profile publish happens here, mid-session — no new MessagePublisher
    // is constructed, exactly like `MessagingService` publishing once per
    // unlock and sending many times after.
    current = hexToBytes("aa".repeat(32));

    await publisher.publishText({
      messageRowId: 31,
      logicalMessageId: "lm-sender-id-after",
      text: "second",
      recipientProfileIdHex: profileIdHex,
    });
    expect(mockAssembleSpy).toHaveBeenCalledTimes(2);
    // This is the exact assertion that would have caught the bug: the SECOND
    // send must carry the NEW real id, not the value captured before it, and
    // certainly not 32 zero bytes.
    expect(Array.from(mockAssembleSpy.mock.calls[1]![0].senderProfileId)).toEqual(
      Array.from(current),
    );
    expect(sentBodies).toHaveLength(2);
  });

  it("rejects with a clear error and sends nothing when no profile has been published", async () => {
    mockAssembleSpy.mockClear();
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher, store, sentBodies } = makeFixture(json, {
      senderProfileId: () =>
        Promise.reject(
          new Error("No profile published yet — publish your profile before sending a message."),
        ),
    });

    const failure = await publisher
      .publishText({
        messageRowId: 32,
        logicalMessageId: "lm-no-sender-profile",
        text: "should never be sent",
        recipientProfileIdHex: profileIdHex,
      })
      .then(
        () => {
          throw new Error("expected publishText to fail");
        },
        (e: unknown) => e,
      );

    expect(failure).toBeInstanceOf(PublicationError);
    // Pre-broadcast failure: never reached send_transaction.
    expect((failure as PublicationError).broadcast).toBe(false);
    expect(sentBodies).toHaveLength(0);
    expect(store.states).toEqual(["encrypting", "failed"]);
    // assembleTextMessage — which would embed the (nonexistent) sender id —
    // must never have run.
    expect(mockAssembleSpy).not.toHaveBeenCalled();
  });
});

describe("MessagePublisher.publishText forwards attachmentEnvelope (spec §6)", () => {
  it("passes the coordination override into assembleTextMessage", async () => {
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher } = makeFixture(json);
    mockAssembleSpy.mockClear();

    // Fresh 32-byte KEM encapsulation seed + 12-byte AEAD nonce (spec §6):
    // the exact override the image-send orchestration (Task 4) will supply.
    const kemMessage = hexToBytes("aa".repeat(32));
    const nonce = hexToBytes("bb".repeat(12));

    await publisher.publishText({
      messageRowId: 40,
      logicalMessageId: "lm-attachment-envelope",
      text: "",
      recipientProfileIdHex: profileIdHex,
      contentType: 0x03,
      attachmentManifests: [],
      attachmentEnvelope: { kemMessage, nonce },
    });

    // This is the behavioural assertion: it fails if publishText stops
    // forwarding input.attachmentEnvelope into the assembleTextMessage call
    // (e.g. if the conditional spread is removed).
    expect(mockAssembleSpy).toHaveBeenCalledTimes(1);
    const passed = mockAssembleSpy.mock.calls[0]?.[0] as {
      attachmentEnvelope?: { kemMessage: Uint8Array; nonce: Uint8Array };
    };
    expect(passed.attachmentEnvelope).toBeDefined();
    expect(Array.from(passed.attachmentEnvelope!.kemMessage)).toEqual(Array.from(kemMessage));
    expect(Array.from(passed.attachmentEnvelope!.nonce)).toEqual(Array.from(nonce));
  });

  it("omits attachmentEnvelope from the assembleTextMessage call when not supplied", async () => {
    const { json, profileIdHex } = recipientProfileCellJson();
    const { publisher } = makeFixture(json);
    mockAssembleSpy.mockClear();

    await publisher.publishText({
      messageRowId: 41,
      logicalMessageId: "lm-no-attachment-envelope",
      text: "plain text message",
      recipientProfileIdHex: profileIdHex,
    });

    expect(mockAssembleSpy).toHaveBeenCalledTimes(1);
    const passed = mockAssembleSpy.mock.calls[0]?.[0] as { attachmentEnvelope?: unknown };
    expect(passed.attachmentEnvelope).toBeUndefined();
  });
});
