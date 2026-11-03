/**
 * AuthenticatedSenderResolver (ADR 0007 §5): the verdict table and the
 * resolver rows of the ADR test plan — pinned key accepts, forged rotation
 * blocked, honest rotation accepted, profile key not matching its lock args
 * refused, RPC failure defers and never downgrades.
 */

import { Script } from "@ckb-ccc/core";
import { CKB_TESTNET, codec } from "@cemp/core";
import {
  deriveIdentityKeys,
  mldsaV2LockArgs,
  openEnvelopeV3,
  sealEnvelopeV3,
  wipeIdentityKeyBundle,
  type IdentityKeyBundle,
} from "@cemp/crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TYPE_ID_CODE_HASH } from "./builders.js";
import {
  AuthenticatedSenderResolver,
  type PinnedSender,
  type SenderChainView,
} from "./sender-resolver.js";
import type { Cell, Transaction } from "./types.js";

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}
const hex = (b: Uint8Array) => codec.bytesToHex(b);
const fillHex = (byte: number, n: number) => `0x${hex(fill(byte, n))}`;

const ALICE = deriveIdentityKeys(fill(0x07, 64));
const ALICE2 = deriveIdentityKeys(fill(0x08, 64)); // Alice after a full rotation
const BOB = deriveIdentityKeys(fill(0x11, 64));
const MALLORY = deriveIdentityKeys(fill(0x4d, 64));
const ALICE_ID = fill(0xaa, 32);
const ALICE2_ID = fill(0xa2, 32);
const BOB_ID = fill(0xbb, 32);
const MLDSA_LOCK = CKB_TESTNET.deployments.mlDsaLock!;
const LOCK_REF = { codeHash: MLDSA_LOCK.codeHash, hashType: MLDSA_LOCK.hashType };

afterAll(() => {
  for (const k of [ALICE, ALICE2, BOB, MALLORY]) wipeIdentityKeyBundle(k);
});

/** Bob opens a v3 message signed by `signer`, claiming `claimedId`. */
function openedFrom(signer: IdentityKeyBundle, claimedId: Uint8Array) {
  const payload: codec.CempPayloadV2 = {
    message_id: fill(0x16, 16),
    body_type: 0x01,
    recipient_profile_id: BOB_ID,
    text: new TextEncoder().encode("hi"),
    attachment_manifests: [],
    reply_to_message_id: undefined,
    reply_to_outpoint: undefined,
    receipts: [],
    receipt_request: 1,
    client_timestamp: 1n,
    sender_device_id: fill(1, 16),
    padding: new Uint8Array(0),
  };
  const sealed = sealEnvelopeV3({
    header: { protocol_version: 3, network: 1, expiry_hint: 0n },
    senderProfileId: claimedId,
    contentType: 0x01,
    createdAtClient: 1n,
    payload,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    signerSecretKey: signer.mlDsa.secretKey,
    signerPublicKey: signer.mlDsa.publicKey,
  });
  return openEnvelopeV3({
    envelopeBytes: sealed.envelopeBytes,
    recipientKemSecretKey: BOB.mlKem.secretKey,
    ownProfileId: BOB_ID,
  });
}

function mldsaLock(pk: Uint8Array) {
  return { ...LOCK_REF, args: `0x${hex(mldsaV2LockArgs(pk))}` };
}

function profileCell(options: {
  id: Uint8Array;
  key: Uint8Array;
  lock?: { codeHash: string; hashType: "type" | "data" | "data1" | "data2"; args: string };
  lockHashOverride?: Uint8Array;
  previous?: Uint8Array;
  revoked?: number;
  outPoint?: { txHash: string; index: string };
}): Cell {
  const lock = options.lock ?? mldsaLock(options.key);
  const lockHash = Script.from(lock).hash();
  const data = codec.encodeCempProfileV1({
    ...codec.buildProfileMinimal(),
    ml_dsa_public_key: options.key,
    lock_script_hash: options.lockHashOverride ?? codec.hexToBytes(lockHash.slice(2)),
    rotation_sequence: options.previous === undefined ? 0 : 1,
    previous_profile_id: options.previous,
    revoked: options.revoked ?? 0,
  });
  return {
    outPoint: options.outPoint ?? { txHash: fillHex(0xc0, 32), index: "0x0" },
    output: {
      capacity: "0x0",
      lock,
      type: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: `0x${hex(options.id)}` },
    },
    data: `0x${hex(data)}`,
  };
}

interface ChainSetup {
  profiles?: Map<string, Cell[]>;
  txs?: Map<string, Transaction | null>;
  failProfiles?: boolean;
  failTxs?: boolean;
}

function chain(setup: ChainSetup): SenderChainView & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findCells(query) {
      calls.push(`findCells ${query.script.args}`);
      if (setup.failProfiles) return Promise.reject(new Error("fetch failed: ECONNREFUSED"));
      const cells = setup.profiles?.get(query.script.args) ?? [];
      return Promise.resolve({ cells, lastCursor: "0x" });
    },
    getTransactionBody(hash) {
      calls.push(`getTransactionBody ${hash}`);
      if (setup.failTxs) return Promise.reject(new Error("RPC timed out"));
      return Promise.resolve(setup.txs?.get(hash) ?? null);
    },
  };
}

function contacts(entries: PinnedSender[]) {
  return {
    findByProfileId(profileIdHex: string) {
      return Promise.resolve(entries.find((e) => e.profileIdHex === profileIdHex));
    },
  };
}

function txWith(inputs: { txHash: string; index: string }[], outputs: Cell[] = []): Transaction {
  return {
    version: "0x0",
    cellDeps: [],
    headerDeps: [],
    inputs: inputs.map((previousOutput) => ({ previousOutput, since: "0x0" })),
    outputs: outputs.map((c) => c.output),
    outputsData: outputs.map((c) => c.data),
    witnesses: [],
  };
}

const ALICE_PINNED: PinnedSender = {
  contactId: 7,
  profileIdHex: hex(ALICE_ID),
  mlDsaPublicKey: ALICE.mlDsa.publicKey,
};

function resolver(view: SenderChainView, pinned: PinnedSender[] = []) {
  return new AuthenticatedSenderResolver({
    chain: view,
    contacts: contacts(pinned),
    mlDsaLock: LOCK_REF,
  });
}

describe("known contact, pinned key", () => {
  it("valid under the pinned key → trusted, with no chain lookups", async () => {
    const view = chain({ failProfiles: true, failTxs: true });
    const verdict = await resolver(view, [ALICE_PINNED]).resolve(openedFrom(ALICE, ALICE_ID));
    expect(verdict.kind).toBe("trusted");
    if (verdict.kind === "trusted") {
      expect(verdict.contactId).toBe(7);
      expect(verdict.verifyingKey).toEqual(ALICE.mlDsa.publicKey);
      expect(verdict.verifyingKeyHashHex).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(view.calls).toEqual([]);
  });

  it("AUTH-01: Mallory signs as Alice; the live key is the pinned key → rejected", async () => {
    const view = chain({
      profiles: new Map([
        [`0x${hex(ALICE_ID)}`, [profileCell({ id: ALICE_ID, key: ALICE.mlDsa.publicKey })]],
      ]),
    });
    const verdict = await resolver(view, [ALICE_PINNED]).resolve(openedFrom(MALLORY, ALICE_ID));
    expect(verdict.kind).toBe("rejected");
  });

  it("pinned key fails and the profile fetch fails → deferred (never downgraded to rejected)", async () => {
    const view = chain({ failProfiles: true });
    const verdict = await resolver(view, [ALICE_PINNED]).resolve(openedFrom(MALLORY, ALICE_ID));
    expect(verdict.kind).toBe("deferred");
  });

  it("same profile id now publishing another key, signature valid under it → key-changed-blocking", async () => {
    const view = chain({
      profiles: new Map([
        [`0x${hex(ALICE_ID)}`, [profileCell({ id: ALICE_ID, key: MALLORY.mlDsa.publicKey })]],
      ]),
    });
    const verdict = await resolver(view, [ALICE_PINNED]).resolve(openedFrom(MALLORY, ALICE_ID));
    expect(verdict.kind).toBe("key-changed-blocking");
    if (verdict.kind === "key-changed-blocking") expect(verdict.contactId).toBe(7);
  });
});

describe("unknown sender", () => {
  const aliceProfiles = () =>
    new Map([[`0x${hex(ALICE_ID)}`, [profileCell({ id: ALICE_ID, key: ALICE.mlDsa.publicKey })]]]);

  it("live profile bound to its ML-DSA lock, signature valid → unknown-signed with the key to pin", async () => {
    const verdict = await resolver(chain({ profiles: aliceProfiles() })).resolve(
      openedFrom(ALICE, ALICE_ID),
    );
    expect(verdict.kind).toBe("unknown-signed");
    if (verdict.kind === "unknown-signed") {
      expect(verdict.verifyingKey).toEqual(ALICE.mlDsa.publicKey);
      expect(verdict.contactId).toBeNull();
      expect(verdict.profile.ml_kem_public_key).toBeInstanceOf(Uint8Array);
    }
  });

  it("a contact row with that profile id but no pinned key is reused (TOFU pin), not duplicated", async () => {
    const stub: PinnedSender = { contactId: 9, profileIdHex: hex(ALICE_ID), mlDsaPublicKey: null };
    const verdict = await resolver(chain({ profiles: aliceProfiles() }), [stub]).resolve(
      openedFrom(ALICE, ALICE_ID),
    );
    expect(verdict.kind).toBe("unknown-signed");
    if (verdict.kind === "unknown-signed") expect(verdict.contactId).toBe(9);
  });

  it("RPC failure → deferred", async () => {
    const verdict = await resolver(chain({ failProfiles: true })).resolve(
      openedFrom(ALICE, ALICE_ID),
    );
    expect(verdict.kind).toBe("deferred");
  });

  it("no live profile → deferred (may be indexer lag; never shown meanwhile)", async () => {
    const verdict = await resolver(chain({})).resolve(openedFrom(ALICE, ALICE_ID));
    expect(verdict.kind).toBe("deferred");
  });

  it("two live cells for one profile id (impossible under Type ID) → rejected", async () => {
    const cell = profileCell({ id: ALICE_ID, key: ALICE.mlDsa.publicKey });
    const verdict = await resolver(
      chain({ profiles: new Map([[`0x${hex(ALICE_ID)}`, [cell, cell]]]) }),
    ).resolve(openedFrom(ALICE, ALICE_ID));
    expect(verdict.kind).toBe("rejected");
  });

  it("signature by another key than the live profile's → rejected", async () => {
    const verdict = await resolver(chain({ profiles: aliceProfiles() })).resolve(
      openedFrom(MALLORY, ALICE_ID),
    );
    expect(verdict.kind).toBe("rejected");
  });

  it("profile advertises a key that does not control its lock (lock args mismatch) → rejected", async () => {
    // Mallory publishes a profile carrying ALICE's public key but locked by
    // Mallory's own ML-DSA lock: the key does not control the profile cell.
    const cell = profileCell({
      id: ALICE_ID,
      key: MALLORY.mlDsa.publicKey,
      lock: mldsaLock(ALICE.mlDsa.publicKey),
    });
    const verdict = await resolver(
      chain({ profiles: new Map([[`0x${hex(ALICE_ID)}`, [cell]]]) }),
    ).resolve(openedFrom(MALLORY, ALICE_ID));
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") expect(verdict.reason).toMatch(/lock args/);
  });

  it("profile cell under a lock that is not the ML-DSA lock → rejected", async () => {
    const cell = profileCell({
      id: ALICE_ID,
      key: ALICE.mlDsa.publicKey,
      lock: {
        codeHash: fillHex(0x77, 32),
        hashType: "type",
        args: `0x${hex(mldsaV2LockArgs(ALICE.mlDsa.publicKey))}`,
      },
    });
    const verdict = await resolver(
      chain({ profiles: new Map([[`0x${hex(ALICE_ID)}`, [cell]]]) }),
    ).resolve(openedFrom(ALICE, ALICE_ID));
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") expect(verdict.reason).toMatch(/ML-DSA lock/);
  });

  it("lock_script_hash not binding the cell's lock → rejected", async () => {
    const cell = profileCell({
      id: ALICE_ID,
      key: ALICE.mlDsa.publicKey,
      lockHashOverride: fill(0x10, 32),
    });
    const verdict = await resolver(
      chain({ profiles: new Map([[`0x${hex(ALICE_ID)}`, [cell]]]) }),
    ).resolve(openedFrom(ALICE, ALICE_ID));
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") expect(verdict.reason).toMatch(/lock_script_hash/);
  });

  it("revoked profile → rejected", async () => {
    const cell = profileCell({ id: ALICE_ID, key: ALICE.mlDsa.publicKey, revoked: 1 });
    const verdict = await resolver(
      chain({ profiles: new Map([[`0x${hex(ALICE_ID)}`, [cell]]]) }),
    ).resolve(openedFrom(ALICE, ALICE_ID));
    expect(verdict.kind).toBe("rejected");
  });
});

describe("rotation (live profile names a pinned contact as predecessor)", () => {
  const PRED_OUTPOINT = { txHash: fillHex(0xa1, 32), index: "0x0" };
  const CREATE_TX = fillHex(0xb2, 32);
  const predecessorCell = (key: Uint8Array) =>
    profileCell({ id: ALICE_ID, key, outPoint: PRED_OUTPOINT });
  const successorCell = profileCell({
    id: ALICE2_ID,
    key: ALICE2.mlDsa.publicKey,
    previous: ALICE_ID,
    outPoint: { txHash: CREATE_TX, index: "0x0" },
  });
  const profiles = new Map([[`0x${hex(ALICE2_ID)}`, [successorCell]]]);

  function txs(consumed: { txHash: string; index: string }, predecessorKey: Uint8Array) {
    return new Map<string, Transaction | null>([
      [CREATE_TX, txWith([consumed])],
      // The tx that CREATED the predecessor cell, so its lock can be read.
      [PRED_OUTPOINT.txHash, txWith([], [predecessorCell(predecessorKey)])],
    ]);
  }

  it("honest rotation: the successor's creating tx consumed the pinned-key profile cell → rotation-verified", async () => {
    const view = chain({ profiles, txs: txs(PRED_OUTPOINT, ALICE.mlDsa.publicKey) });
    const verdict = await resolver(view, [ALICE_PINNED]).resolve(openedFrom(ALICE2, ALICE2_ID));
    expect(verdict.kind).toBe("rotation-verified");
    if (verdict.kind === "rotation-verified") {
      expect(verdict.contactId).toBe(7);
      expect(verdict.previousProfileIdHex).toBe(hex(ALICE_ID));
      expect(verdict.verifyingKey).toEqual(ALICE2.mlDsa.publicKey);
    }
  });

  it("forged rotation: the predecessor was NOT consumed → key-changed-blocking", async () => {
    const other = { txHash: fillHex(0xee, 32), index: "0x0" };
    const view = chain({
      profiles,
      txs: new Map<string, Transaction | null>([
        [CREATE_TX, txWith([other])],
        [
          other.txHash,
          txWith([], [profileCell({ id: fill(0x01, 32), key: MALLORY.mlDsa.publicKey })]),
        ],
      ]),
    });
    const verdict = await resolver(view, [ALICE_PINNED]).resolve(openedFrom(ALICE2, ALICE2_ID));
    expect(verdict.kind).toBe("key-changed-blocking");
    if (verdict.kind === "key-changed-blocking") expect(verdict.contactId).toBe(7);
  });

  it("forged rotation: consumed a cell with the predecessor id but locked by another key → key-changed-blocking", async () => {
    const view = chain({ profiles, txs: txs(PRED_OUTPOINT, MALLORY.mlDsa.publicKey) });
    const verdict = await resolver(view, [ALICE_PINNED]).resolve(openedFrom(ALICE2, ALICE2_ID));
    expect(verdict.kind).toBe("key-changed-blocking");
  });

  it("transaction lookups fail → deferred, not blocking and not trusted", async () => {
    const view = chain({ profiles, failTxs: true });
    const verdict = await resolver(view, [ALICE_PINNED]).resolve(openedFrom(ALICE2, ALICE2_ID));
    expect(verdict.kind).toBe("deferred");
  });

  it("a named predecessor that is not a pinned contact is just an unknown sender", async () => {
    const view = chain({ profiles, txs: new Map() });
    const verdict = await resolver(view).resolve(openedFrom(ALICE2, ALICE2_ID));
    expect(verdict.kind).toBe("unknown-signed");
  });
});
