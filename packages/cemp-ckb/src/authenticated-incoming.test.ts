/**
 * ADR 0007 §6: the type system (and a runtime registry behind it) enforces
 * the order "verify the signature, THEN touch receipts and contacts".
 * `AuthenticatedIncoming` exists only when the verifier made it; a
 * structurally identical copy is not one, at compile time or at run time.
 */

import { CKB_TESTNET, codec } from "@cemp/core";
import {
  computeReceiptProof,
  deriveIdentityKeys,
  wipeIdentityKeyBundle,
  type IdentityKeyBundle,
} from "@cemp/crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assembleTextMessageV3 } from "./assemble.js";
import {
  authenticateIncomingV3,
  isAuthenticatedIncoming,
  type AuthenticatedIncoming,
} from "./authenticated-incoming.js";
import { openIncoming } from "./incoming.js";
import { ResponseLifecycle, type LifecycleStore } from "./lifecycle.js";
import { AuthenticatedSenderResolver, type PinnedSender } from "./sender-resolver.js";

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}
const hex = codec.bytesToHex;

const ALICE = deriveIdentityKeys(fill(0x07, 64));
const BOB = deriveIdentityKeys(fill(0x11, 64));
const MALLORY = deriveIdentityKeys(fill(0x4d, 64));
const ALICE_ID = fill(0xaa, 32);
const BOB_ID = fill(0xbb, 32);
const MLDSA_LOCK = CKB_TESTNET.deployments.mlDsaLock!;
afterAll(() => {
  for (const k of [ALICE, BOB, MALLORY]) wipeIdentityKeyBundle(k);
});

const ORIGINAL_ID = fill(0x16, 16);
const RECEIPT_KEY = fill(0x5a, 32);

/** Bob (pinned at Alice) receives a v3 ack for ORIGINAL_ID, signed by `signer` as Bob. */
function ackFrom(signer: IdentityKeyBundle) {
  return assembleTextMessageV3({
    text: "",
    senderProfileId: BOB_ID,
    signerSecretKey: signer.mlDsa.secretKey,
    signerPublicKey: signer.mlDsa.publicKey,
    recipientProfileId: ALICE_ID,
    recipientKemPublicKey: ALICE.mlKem.publicKey,
    senderDeviceId: fill(1, 16),
    receipts: [
      {
        messageId: ORIGINAL_ID,
        status: 0x01,
        proof: computeReceiptProof(RECEIPT_KEY, ORIGINAL_ID, 0x01),
      },
    ],
  }).envelopeBytes;
}

function aliceResolver() {
  const bobPinned: PinnedSender = {
    contactId: 3,
    profileIdHex: hex(BOB_ID),
    mlDsaPublicKey: BOB.mlDsa.publicKey,
  };
  return new AuthenticatedSenderResolver({
    chain: {
      findCells: () => Promise.reject(new Error("offline")),
      getTransactionBody: () => Promise.reject(new Error("offline")),
    },
    contacts: {
      findByProfileId: (id) =>
        Promise.resolve(id === bobPinned.profileIdHex ? bobPinned : undefined),
    },
    mlDsaLock: { codeHash: MLDSA_LOCK.codeHash, hashType: MLDSA_LOCK.hashType },
  });
}

async function aliceReceives(bytes: Uint8Array) {
  const opened = openIncoming({
    cellData: bytes,
    ownKemSecretKey: ALICE.mlKem.secretKey,
    ownProfileId: ALICE_ID,
  });
  if (opened.kind !== "v3") throw new Error("expected v3");
  return authenticateIncomingV3(opened.unverified, aliceResolver());
}

function fakeStore() {
  const transitions: string[] = [];
  const store = {
    findOutgoingByEnvelopeMessageId: (idHex: string) =>
      Promise.resolve(
        idHex === hex(ORIGINAL_ID)
          ? {
              rowId: 1,
              state: "available_on_chain",
              recipientProfileIdHex: hex(BOB_ID),
              receiptKey: RECEIPT_KEY.slice(),
            }
          : undefined,
      ),
    transitionMessage: (_row: number, to: string) => {
      transitions.push(to);
      return Promise.resolve();
    },
    getMessageJournalInfo: () => Promise.resolve(undefined),
    markCapacityReclaimable: () => Promise.resolve(),
    markAttachmentRemoteDownloaded: () => Promise.resolve(),
  };
  return { store: store as unknown as LifecycleStore, transitions };
}

function lifecycle(store: LifecycleStore) {
  return new ResponseLifecycle({
    client: undefined as never,
    signer: undefined as never,
    messageType: undefined as never,
    store,
  });
}

describe("authenticateIncomingV3", () => {
  it("a message signed by the pinned key becomes an AuthenticatedIncoming", async () => {
    const outcome = await aliceReceives(ackFrom(BOB));
    expect(outcome.kind).toBe("authenticated");
    if (outcome.kind !== "authenticated") return;
    const message = outcome.message;
    expect(isAuthenticatedIncoming(message)).toBe(true);
    expect(message.protocolVersion).toBe(3);
    expect(message.senderProfileId).toEqual(BOB_ID);
    expect(message.verdict.kind).toBe("trusted");
    expect(message.verifyingKeyHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(message.receipts[0]?.proof).toEqual(computeReceiptProof(RECEIPT_KEY, ORIGINAL_ID, 0x01));
  });

  it("Mallory signing as Bob is rejected: nothing is minted", async () => {
    const outcome = await aliceReceives(ackFrom(MALLORY));
    // Pinned key fails; the chain is offline, so the honest answer is
    // "deferred" — never "authenticated".
    expect(outcome.kind).toBe("deferred");
    expect("message" in outcome).toBe(false);
  });
});

describe("processAcknowledgements accepts only verifier-made input", () => {
  it("applies a proven receipt from an AuthenticatedIncoming", async () => {
    const outcome = await aliceReceives(ackFrom(BOB));
    if (outcome.kind !== "authenticated") throw new Error("expected authenticated");
    const { store, transitions } = fakeStore();
    expect(await lifecycle(store).processAcknowledgements(outcome.message)).toEqual([1]);
    expect(transitions).toContain("reclaim_queued");
  });

  it("a structurally identical copy has no effect (runtime brand check)", async () => {
    const outcome = await aliceReceives(ackFrom(BOB));
    if (outcome.kind !== "authenticated") throw new Error("expected authenticated");
    const forged = { ...outcome.message } as AuthenticatedIncoming;
    expect(isAuthenticatedIncoming(forged)).toBe(false);
    const { store, transitions } = fakeStore();
    expect(await lifecycle(store).processAcknowledgements(forged)).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("an unverified v3 message does not type-check as input", async () => {
    const opened = openIncoming({
      cellData: ackFrom(BOB),
      ownKemSecretKey: ALICE.mlKem.secretKey,
      ownProfileId: ALICE_ID,
    });
    if (opened.kind !== "v3") throw new Error("expected v3");
    const { store, transitions } = fakeStore();
    // @ts-expect-error — an UnverifiedIncomingV3 message is not AuthenticatedIncoming.
    expect(await lifecycle(store).processAcknowledgements(opened.unverified.message)).toEqual([]);
    expect(transitions).toEqual([]);
  });
});
