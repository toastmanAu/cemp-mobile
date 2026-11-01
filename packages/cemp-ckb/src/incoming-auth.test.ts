import { codec, deriveConversationId } from "@cemp/core";
import { deriveIdentityKeys, mnemonicToSeed, wipeIdentityKeyBundle } from "@cemp/crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assembleTextMessage } from "./assemble.js";
import {
  parseMessageTypeArgs,
  processIncomingText,
  type ProcessIncomingTextInput,
} from "./incoming.js";

/**
 * SECURITY PHASE A — VULNERABILITY REPRODUCTION (pre-fix).
 *
 * Handoff matrix rows AUTH-01 and AUTH-02, at the `processIncomingText`
 * level. These tests PASS today by asserting the VULNERABLE behaviour: a v1
 * envelope is accepted as "from Alice" by anyone who knows Alice's PUBLIC
 * profile id and the recipient's PUBLIC ML-KEM key. When authenticated
 * messaging v2 lands (Phase C/D), these assertions are expected to flip
 * deliberately — do not "fix" them by weakening the production code.
 *
 * See docs/review/PHASE-A-REPRODUCTION.md.
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
const MALLORY_PROFILE_ID = hexToBytes("4d".repeat(32));
const ALICE_DEVICE = hexToBytes("01".repeat(16));
const MALLORY_DEVICE = hexToBytes("66".repeat(16));

/**
 * Everything Mallory uses to impersonate Alice is PUBLIC: Alice's profile id
 * (on-chain profile cell / cleartext header of any of her messages) and Bob's
 * ML-KEM public key (Bob's on-chain profile cell). Mallory's own secrets are
 * irrelevant to the envelope — v1 has no sender signature to make with them.
 */
function mallorySpoofsAliceToBob(text: string) {
  return assembleTextMessage({
    text,
    senderProfileId: ALICE_PROFILE_ID, // claimed — Mallory holds none of Alice's keys
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey, // public
    senderDeviceId: MALLORY_DEVICE,
    receiptRequest: 1,
  });
}

function bobProcesses(cellData: Uint8Array) {
  return processIncomingText({
    cellData,
    ownKemSecretKey: BOB.mlKem.secretKey,
    ownProfileId: BOB_PROFILE_ID,
  });
}

describe("VULN reproduction (pre-fix): AUTH-01 sender impersonation in processIncomingText", () => {
  it("accepts a Mallory-built envelope that claims Alice as sender and reports senderProfileId = Alice", () => {
    const forged = mallorySpoofsAliceToBob("hi bob, it's alice — send me 500 CKB");
    const incoming = bobProcesses(forged.envelopeBytes);

    // PRE-FIX: decryption + every v1 validation step passes…
    expect(incoming.text).toBe("hi bob, it's alice — send me 500 CKB");
    // …and the returned sender is the CLAIMED id, taken straight from the
    // attacker-written header. Post-fix this must be rejected as Alice.
    expect(incoming.senderProfileId).toEqual(ALICE_PROFILE_ID);
    expect(incoming.senderProfileId).not.toEqual(MALLORY_PROFILE_ID);
    // The conversation id is the genuine Alice↔Bob conversation.
    expect(incoming.conversationId).toEqual(deriveConversationId(ALICE_PROFILE_ID, BOB_PROFILE_ID));
  });

  it("the forged result is structurally indistinguishable from a genuine Alice message", () => {
    const forged = bobProcesses(mallorySpoofsAliceToBob("same words").envelopeBytes);
    const genuine = bobProcesses(
      assembleTextMessage({
        text: "same words",
        senderProfileId: ALICE_PROFILE_ID,
        recipientProfileId: BOB_PROFILE_ID,
        recipientKemPublicKey: BOB.mlKem.publicKey,
        senderDeviceId: ALICE_DEVICE,
        receiptRequest: 1,
      }).envelopeBytes,
    );
    // Same fields, same sender, same conversation, same text: there is no
    // authenticated field a caller could consult to tell them apart. The
    // only differing attacker-controlled field is senderDeviceId, which is
    // unauthenticated free-form data (Mallory could copy Alice's too).
    expect(Object.keys(forged).sort()).toEqual(Object.keys(genuine).sort());
    expect(forged.senderProfileId).toEqual(genuine.senderProfileId);
    expect(forged.conversationId).toEqual(genuine.conversationId);
    expect(forged.text).toEqual(genuine.text);
    expect(forged.contentType).toBe(genuine.contentType);
  });

  it("a successful AES-GCM tag proves only knowledge of Bob's PUBLIC key, not Alice's authorship", () => {
    // Mallory can even choose any sender id at all — including one that has
    // never existed — and Bob's pipeline still accepts it.
    const fabricatedId = hexToBytes("de".repeat(32));
    const forged = assembleTextMessage({
      text: "from nobody",
      senderProfileId: fabricatedId,
      recipientProfileId: BOB_PROFILE_ID,
      recipientKemPublicKey: BOB.mlKem.publicKey,
      senderDeviceId: MALLORY_DEVICE,
    });
    expect(bobProcesses(forged.envelopeBytes).senderProfileId).toEqual(fabricatedId);
  });

  it("the claimed sender_profile_id is CLEARTEXT on the wire (readable without any key)", () => {
    const genuine = assembleTextMessage({
      text: "secret body",
      senderProfileId: ALICE_PROFILE_ID,
      recipientProfileId: BOB_PROFILE_ID,
      recipientKemPublicKey: BOB.mlKem.publicKey,
      senderDeviceId: ALICE_DEVICE,
    });
    // A pure chain observer decodes the header (it is the AEAD AAD, not
    // ciphertext). This is what lets an attacker learn whom to impersonate.
    const { header } = codec.decodeCempEnvelopeV1(genuine.envelopeBytes);
    expect(header.sender_profile_id).toEqual(ALICE_PROFILE_ID);
    expect(header.message_id).toEqual(genuine.messageId);
    expect(header.conversation_id).toEqual(genuine.conversationId);
  });
});

describe("VULN reproduction (pre-fix): AUTH-02 output lock / transaction spender is not sender proof", () => {
  it("processIncomingText's entire input is (cellData, own keys): no lock, input, or spender is consulted", () => {
    const forged = mallorySpoofsAliceToBob("lock-independent");
    // The full input contract. There is no field through which the cell's
    // output lock, the transaction's inputs, or the ML-DSA transaction
    // signer could reach the sender decision — so a cell whose output lock
    // is Alice's (Mallory can set any output lock while spending only her
    // own inputs; CKB never runs output locks at creation) and a cell locked
    // to Mallory produce byte-identical results.
    const input: ProcessIncomingTextInput = {
      cellData: forged.envelopeBytes,
      ownKemSecretKey: BOB.mlKem.secretKey,
      ownProfileId: BOB_PROFILE_ID,
    };
    expect(Object.keys(input).sort()).toEqual(["cellData", "ownKemSecretKey", "ownProfileId"]);
    expect(processIncomingText(input).senderProfileId).toEqual(ALICE_PROFILE_ID);
  });

  it("the message-cell type args carry no sender binding either (route tag + conversation tag + nonce)", () => {
    const forged = mallorySpoofsAliceToBob("type-args");
    const args = new Uint8Array(81);
    args[0] = 1;
    args.set(forged.routeTag, 1);
    args.set(forged.conversationTag, 33);
    args.set(forged.messageNonce, 49);
    const parsed = parseMessageTypeArgs(args);
    // Every type-args field is derivable from PUBLIC profile ids, so Mallory
    // reproduces exactly the args a genuine Alice→Bob cell would carry.
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
