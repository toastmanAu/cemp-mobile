import { deriveIdentityKeys, mnemonicToSeed, wipeIdentityKeyBundle } from "@cemp/crypto";
import { afterAll, describe, expect, it } from "vitest";
import { assembleTextMessage } from "./assemble.js";
import { incomingLogicalMessageId, parseMessageTypeArgs, processIncomingText } from "./incoming.js";

/**
 * Incoming pipeline (Phase 7 exit criteria: "Device B discovers and decrypts",
 * "duplicate indexing does not create duplicate chat messages"). Fully
 * offline: Alice assembles, Bob processes.
 */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const ALICE = deriveIdentityKeys(
  mnemonicToSeed("legal winner thank year wave sausage worth useful legal winner thank yellow"),
);
const BOB = deriveIdentityKeys(
  mnemonicToSeed("letter advice cage absurd amount doctor acoustic avoid letter advice cage above"),
);
const ALICE_PROFILE_ID = hexToBytes("aa".repeat(32));
const BOB_PROFILE_ID = hexToBytes("bb".repeat(32));
const ALICE_DEVICE = hexToBytes("01".repeat(16));

function assembleForBob(text: string, messageId?: Uint8Array) {
  return assembleTextMessage({
    text,
    senderProfileId: ALICE_PROFILE_ID,
    recipientProfileId: BOB_PROFILE_ID,
    recipientKemPublicKey: BOB.mlKem.publicKey,
    senderDeviceId: ALICE_DEVICE,
    receiptRequest: 1,
    ...(messageId === undefined ? {} : { messageId }),
  });
}

describe("processIncomingText", () => {
  it("Bob decrypts Alice's text (discover → decrypt round-trip)", () => {
    const assembled = assembleForBob("hello bob — phase 7");
    const incoming = processIncomingText({
      cellData: assembled.envelopeBytes,
      ownKemSecretKey: BOB.mlKem.secretKey,
      ownProfileId: BOB_PROFILE_ID,
    });
    expect(incoming.text).toBe("hello bob — phase 7");
    expect(incoming.senderProfileId).toEqual(ALICE_PROFILE_ID);
    expect(incoming.messageId).toEqual(assembled.messageId);
    expect(incoming.conversationId).toEqual(assembled.conversationId);
    expect(incoming.replyToMessageId).toBeNull();
    expect(incoming.receipts).toEqual([]);
  });

  it("the same message id dedups duplicate indexing (exit criterion 4)", () => {
    const fixedId = hexToBytes("1234567890abcdef1234567890abcdef");
    const first = assembleForBob("one", fixedId);
    // The idempotency key is stable for the envelope's message id…
    expect(incomingLogicalMessageId(fixedId)).toBe(
      `incoming:${"1234567890abcdef1234567890abcdef"}`,
    );
    // …and the SAME cell processed twice yields the same logical id (the
    // messages table's UNIQUE constraint collapses the second insert).
    const a = processIncomingText({
      cellData: first.envelopeBytes,
      ownKemSecretKey: BOB.mlKem.secretKey,
      ownProfileId: BOB_PROFILE_ID,
    });
    const b = processIncomingText({
      cellData: first.envelopeBytes,
      ownKemSecretKey: BOB.mlKem.secretKey,
      ownProfileId: BOB_PROFILE_ID,
    });
    expect(incomingLogicalMessageId(a.messageId)).toBe(incomingLogicalMessageId(b.messageId));
  });

  it("rejects tampered envelopes, wrong recipients and wrong profile ids", () => {
    const assembled = assembleForBob("integrity");
    // Bit-flipped ciphertext → AEAD failure.
    const tampered = assembled.envelopeBytes.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() =>
      processIncomingText({
        cellData: tampered,
        ownKemSecretKey: BOB.mlKem.secretKey,
        ownProfileId: BOB_PROFILE_ID,
      }),
    ).toThrow();
    // Wrong secret key → decapsulation yields a wrong shared secret → AEAD failure.
    expect(() =>
      processIncomingText({
        cellData: assembled.envelopeBytes,
        ownKemSecretKey: ALICE.mlKem.secretKey,
        ownProfileId: BOB_PROFILE_ID,
      }),
    ).toThrow();
    // Wrong own profile id → recipient binding fails (spec §12.5).
    expect(() =>
      processIncomingText({
        cellData: assembled.envelopeBytes,
        ownKemSecretKey: BOB.mlKem.secretKey,
        ownProfileId: ALICE_PROFILE_ID,
      }),
    ).toThrow();
  });
});

describe("parseMessageTypeArgs", () => {
  it("parses a well-formed 81-byte args layout", () => {
    const assembled = assembleForBob("tags");
    const args = new Uint8Array(81);
    args[0] = 1;
    args.set(assembled.routeTag, 1);
    args.set(assembled.conversationTag, 33);
    args.set(assembled.messageNonce, 49);
    const parsed = parseMessageTypeArgs(args);
    expect(parsed.routeTag).toEqual(assembled.routeTag);
    expect(parsed.conversationTag).toEqual(assembled.conversationTag);
    expect(parsed.messageNonce).toEqual(assembled.messageNonce);
  });

  it("rejects wrong lengths, versions and nonzero reserved bytes", () => {
    expect(() => parseMessageTypeArgs(new Uint8Array(80))).toThrow(/81/);
    const wrongVersion = new Uint8Array(81);
    wrongVersion[0] = 2;
    expect(() => parseMessageTypeArgs(wrongVersion)).toThrow(/version/);
    const dirtyReserved = new Uint8Array(81);
    dirtyReserved[0] = 1;
    dirtyReserved[80] = 1;
    expect(() => parseMessageTypeArgs(dirtyReserved)).toThrow(/reserved/);
  });
});

afterAll(() => {
  wipeIdentityKeyBundle(ALICE);
  wipeIdentityKeyBundle(BOB);
});
