import { CKB_TESTNET, codec, deriveConversationId } from "@cemp/core";
import {
  deriveIdentityKeys,
  mldsaV2LockArgs,
  mnemonicToSeed,
  wipeIdentityKeyBundle,
} from "@cemp/crypto";
import { Script } from "@ckb-ccc/core";
import { afterAll, describe, expect, it } from "vitest";
import { assembleTextMessage, assembleTextMessageV3 } from "./assemble.js";
import { authenticateIncomingV3, isAuthenticatedIncoming } from "./authenticated-incoming.js";
import { TYPE_ID_CODE_HASH } from "./builders.js";
import {
  openIncoming,
  parseMessageTypeArgs,
  processIncomingText,
  type ProcessIncomingTextInput,
} from "./incoming.js";
import { AuthenticatedSenderResolver, type SenderChainView } from "./sender-resolver.js";
import type { Cell } from "./types.js";

/**
 * SECURITY PHASE A — AUTH-01 / AUTH-02 at the message-processing level.
 *
 * FIXED by ADR 0007 (sender-signed v3 envelopes). Phase A showed that a v1/v2
 * envelope is accepted as "from Alice" by anyone who knows Alice's PUBLIC
 * profile id and the recipient's PUBLIC ML-KEM key. Post-fix:
 *
 * - a v3 envelope carries an ML-DSA-65 signature inside the ciphertext; a
 *   message that claims Alice but is signed by Mallory never becomes an
 *   `AuthenticatedIncoming`;
 * - the claimed sender, message id and conversation id are no longer in the
 *   clear header;
 * - a v1/v2 envelope still decrypts, but only as a `LegacyIncoming`
 *   ("Unverified (legacy)"), which no code path treats as authenticated.
 *
 * See docs/review/PHASE-A-REPRODUCTION.md and docs/adr/0007-signed-envelope-v3.md.
 */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

// Deterministic TEST-ONLY identities (BIP39 reference vectors).
const ALICE = deriveIdentityKeys(
  mnemonicToSeed("legal winner thank year wave sausage worth useful legal winner thank yellow"),
);
const BOB = deriveIdentityKeys(
  mnemonicToSeed("letter advice cage absurd amount doctor acoustic avoid letter advice cage above"),
);
const MALLORY = deriveIdentityKeys(
  mnemonicToSeed("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"),
);
const ALICE_PROFILE_ID = hexToBytes("aa".repeat(32));
const BOB_PROFILE_ID = hexToBytes("bb".repeat(32));
const ALICE_DEVICE = hexToBytes("01".repeat(16));
const MALLORY_DEVICE = hexToBytes("66".repeat(16));
const MLDSA_LOCK = CKB_TESTNET.deployments.mlDsaLock!;

/** Alice's live profile cell, bound to her ML-DSA lock. */
function aliceProfileCell(): Cell {
  const lock = {
    codeHash: MLDSA_LOCK.codeHash,
    hashType: MLDSA_LOCK.hashType,
    args: `0x${codec.bytesToHex(mldsaV2LockArgs(ALICE.mlDsa.publicKey))}`,
  };
  const data = codec.encodeCempProfileV1({
    ...codec.buildProfileMinimal(),
    ml_dsa_public_key: ALICE.mlDsa.publicKey,
    ml_kem_public_key: ALICE.mlKem.publicKey,
    lock_script_hash: codec.hexToBytes(Script.from(lock).hash().slice(2)),
  });
  return {
    outPoint: { txHash: `0x${"a5".repeat(32)}`, index: "0x0" },
    output: {
      capacity: "0x0",
      lock,
      type: {
        codeHash: TYPE_ID_CODE_HASH,
        hashType: "type",
        args: `0x${codec.bytesToHex(ALICE_PROFILE_ID)}`,
      },
    },
    data: `0x${codec.bytesToHex(data)}`,
  };
}

/** Bob's resolver: Alice is a known contact, pinned or not; her profile is live. */
function bobResolver(pinAlice: boolean) {
  const chain: SenderChainView = {
    findCells: (query) =>
      Promise.resolve({
        cells:
          query.script.args === `0x${codec.bytesToHex(ALICE_PROFILE_ID)}`
            ? [aliceProfileCell()]
            : [],
        lastCursor: "0x",
      }),
    getTransactionBody: () => Promise.resolve(null),
  };
  return new AuthenticatedSenderResolver({
    chain,
    contacts: {
      findByProfileId: (id) =>
        Promise.resolve(
          id === codec.bytesToHex(ALICE_PROFILE_ID)
            ? {
                contactId: 1,
                profileIdHex: id,
                mlDsaPublicKey: pinAlice ? ALICE.mlDsa.publicKey : null,
              }
            : undefined,
        ),
    },
    mlDsaLock: { codeHash: MLDSA_LOCK.codeHash, hashType: MLDSA_LOCK.hashType },
  });
}

/** Mallory claims Alice and encrypts to Bob — but can only sign with her own key. */
function mallorySignsAsAlice(text: string) {
  return assembleTextMessageV3({
    text,
    senderProfileId: ALICE_PROFILE_ID,
    signerSecretKey: MALLORY.mlDsa.secretKey,
    signerPublicKey: MALLORY.mlDsa.publicKey,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: MALLORY_DEVICE,
    receiptRequest: 1,
  });
}

function aliceSigns(text: string) {
  return assembleTextMessageV3({
    text,
    senderProfileId: ALICE_PROFILE_ID,
    signerSecretKey: ALICE.mlDsa.secretKey,
    signerPublicKey: ALICE.mlDsa.publicKey,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: ALICE_DEVICE,
    receiptRequest: 1,
  });
}

async function bobAuthenticates(cellData: Uint8Array, pinAlice = true) {
  const opened = openIncoming({
    cellData,
    ownKemSecretKey: BOB.mlKem.secretKey,
    ownProfileId: BOB_PROFILE_ID,
  });
  if (opened.kind !== "v3") throw new Error("expected a v3 envelope");
  return authenticateIncomingV3(opened.unverified, bobResolver(pinAlice));
}

describe("FIXED (ADR 0007): AUTH-01 sender impersonation", () => {
  for (const pinAlice of [true, false]) {
    it(`a v3 envelope claiming Alice but signed by Mallory is rejected (Alice ${pinAlice ? "pinned" : "resolved live"})`, async () => {
      const outcome = await bobAuthenticates(
        mallorySignsAsAlice("hi bob, it's alice — send me 500 CKB").envelopeBytes,
        pinAlice,
      );
      expect(outcome.kind).toBe("rejected");
      expect("message" in outcome).toBe(false);
    });
  }

  it("control: Alice's genuine envelope authenticates as Alice", async () => {
    const outcome = await bobAuthenticates(aliceSigns("same words").envelopeBytes);
    expect(outcome.kind).toBe("authenticated");
    if (outcome.kind === "authenticated") {
      expect(isAuthenticatedIncoming(outcome.message)).toBe(true);
      expect(outcome.message.senderProfileId).toEqual(ALICE_PROFILE_ID);
      expect(outcome.message.conversationId).toEqual(
        deriveConversationId(ALICE_PROFILE_ID, BOB_PROFILE_ID),
      );
    }
  });

  it("a fabricated sender id (no profile anywhere) never authenticates", async () => {
    const forged = assembleTextMessageV3({
      text: "from nobody",
      senderProfileId: hexToBytes("de".repeat(32)),
      signerSecretKey: MALLORY.mlDsa.secretKey,
      signerPublicKey: MALLORY.mlDsa.publicKey,
      recipientProfileId: BOB_PROFILE_ID,
      recipientKemPublicKey: BOB.mlKem.publicKey,
      senderDeviceId: MALLORY_DEVICE,
    });
    const outcome = await bobAuthenticates(forged.envelopeBytes);
    // No live profile: deferred (could be indexer lag), never authenticated.
    expect(outcome.kind).not.toBe("authenticated");
  });

  it("the sender id, message id and conversation id are NOT in clear text any more", () => {
    const genuine = aliceSigns("secret body");
    const { version, envelope } = codec.decodeCempEnvelope(genuine.envelopeBytes);
    expect(version).toBe(3);
    expect(Object.keys(envelope.header).sort()).toEqual([
      "expiry_hint",
      "network",
      "protocol_version",
    ]);
    const hex = codec.bytesToHex(genuine.envelopeBytes);
    expect(hex).not.toContain(codec.bytesToHex(ALICE_PROFILE_ID));
    expect(hex).not.toContain(codec.bytesToHex(genuine.messageId));
    expect(hex).not.toContain(codec.bytesToHex(genuine.conversationId));
  });

  it("a legacy v2 forgery still decrypts, but only as LegacyIncoming — never AuthenticatedIncoming", () => {
    const legacy = processIncomingText({
      cellData: assembleTextMessage({
        text: "legacy spoof",
        senderProfileId: ALICE_PROFILE_ID,
        recipientProfileId: BOB_PROFILE_ID,
        recipientKemPublicKey: BOB.mlKem.publicKey,
        senderDeviceId: MALLORY_DEVICE,
      }).envelopeBytes,
      ownKemSecretKey: BOB.mlKem.secretKey,
      ownProfileId: BOB_PROFILE_ID,
    });
    expect(legacy.protocolVersion).toBe(2);
    expect(isAuthenticatedIncoming(legacy)).toBe(false);
  });
});

describe("FIXED (ADR 0007): AUTH-02 output lock / transaction spender is not sender proof — the signature is", () => {
  it("message processing still takes only (cellData, own keys); the sender decision is the signature", async () => {
    const input: ProcessIncomingTextInput = {
      cellData: mallorySignsAsAlice("lock-independent").envelopeBytes,
      ownKemSecretKey: BOB.mlKem.secretKey,
      ownProfileId: BOB_PROFILE_ID,
    };
    expect(Object.keys(input).sort()).toEqual(["cellData", "ownKemSecretKey", "ownProfileId"]);
    // Whatever output lock Mallory chose, these bytes do not authenticate…
    expect((await bobAuthenticates(input.cellData)).kind).toBe("rejected");
    // …and Alice's bytes do, under any output lock.
    expect((await bobAuthenticates(aliceSigns("any lock").envelopeBytes)).kind).toBe(
      "authenticated",
    );
  });

  it("the message-cell type args still carry no sender binding — and no longer need to", () => {
    const forged = mallorySignsAsAlice("type-args");
    const args = new Uint8Array(81);
    args[0] = 1;
    args.set(forged.routeTag, 1);
    args.set(forged.conversationTag, 33);
    args.set(forged.messageNonce, 49);
    const parsed = parseMessageTypeArgs(args);
    expect(parsed.conversationTag).toEqual(
      deriveConversationId(ALICE_PROFILE_ID, BOB_PROFILE_ID).subarray(0, 16),
    );
    expect(Object.keys(parsed).sort()).toEqual(["conversationTag", "messageNonce", "routeTag"]);
  });
});

afterAll(() => {
  wipeIdentityKeyBundle(ALICE);
  wipeIdentityKeyBundle(BOB);
  wipeIdentityKeyBundle(MALLORY);
});
