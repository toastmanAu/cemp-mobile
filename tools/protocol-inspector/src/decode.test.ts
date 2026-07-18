import { describe, expect, it } from "vitest";
import { CKB_TESTNET, codec } from "@cemp/core";
import { deriveIdentityKeys, mnemonicToSeed, wipeIdentityKeyBundle } from "@cemp/crypto";
import { assembleTextMessage } from "@cemp/ckb";
import vectors from "../../../packages/cemp-test-vectors/vectors/cemp-v1-envelope.json";
import { classifyCell, decodeEnvelope, decodeProfile, hexToBytes } from "./decode.js";
import { decryptPayloadView } from "./payload.js";

/**
 * Inspector decoder tests: structural views against golden vectors, profile
 * decode, type-args classification, and the keyed payload path — including
 * the default no-plaintext rule.
 */
function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

describe("decodeEnvelope", () => {
  it("decodes the golden v1 envelope structurally", () => {
    const bytes = hexToBytes(vectors.cases[0]!.envelopeBytes);
    const view = decodeEnvelope(bytes);
    expect(view.protocolVersion).toBe(1);
    expect(view.network).toBe(0x01);
    expect(view.contentType).toBe(0x01);
    expect(view.kemCiphertextBytes).toBe(1088);
    expect(view.nonceBytes).toBe(12);
    expect(view.totalBytes).toBe(bytes.length);
  });

  it("rejects garbage with a plain reason", () => {
    expect(() => decodeEnvelope(new Uint8Array(10))).toThrow(/envelope rejected/);
  });
});

describe("decodeProfile", () => {
  it("decodes a codec-built profile", () => {
    const bytes = codec.encodeCempProfileV1(codec.buildProfileBoundaries());
    const view = decodeProfile(bytes);
    expect(view.protocolVersion).toBe(1);
    expect(view.rotationSequence).toBe(0);
    expect(view.previousProfileId).toBeNull();
    expect(view.revoked).toBe(false);
    expect(view.supportedProtocolVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("decodes rotation fields on a rotated profile", () => {
    const bytes = codec.encodeCempProfileV1({
      ...codec.buildProfileMinimal(),
      rotation_sequence: 3,
      previous_profile_id: fill(0x11, 32),
      revoked: 1,
    });
    const view = decodeProfile(bytes);
    expect(view.rotationSequence).toBe(3);
    expect(view.previousProfileId).toBe(`0x${"11".repeat(32)}`);
    expect(view.revoked).toBe(true);
  });
});

describe("classifyCell", () => {
  it("classifies message, profile, and data cells", () => {
    const typeArgs = new Uint8Array(81);
    typeArgs[0] = 1;
    typeArgs.set(fill(0xaa, 32), 1);
    typeArgs.set(fill(0xbb, 16), 33);
    typeArgs.set(fill(0xcc, 16), 49);
    const messageCell = {
      outPoint: { txHash: `0x${"11".repeat(32)}`, index: "0x0" },
      output: {
        capacity: "0x100",
        lock: { codeHash: `0x${"22".repeat(32)}`, hashType: "type" as const, args: "0x" },
        type: {
          codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
          hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
          args: `0x${Array.from(typeArgs, (b) => b.toString(16).padStart(2, "0")).join("")}`,
        },
      },
      data: "0x",
      blockNumber: "0x1",
    };
    const kind = classifyCell(messageCell);
    expect(kind.kind).toBe("message-cell");
    if (kind.kind === "message-cell") {
      expect(kind.reservedAllZero).toBe(true);
      expect(kind.routeTag).toBe(`0x${"aa".repeat(32)}`);
    }

    const profileCell = {
      ...messageCell,
      output: {
        ...messageCell.output,
        type: {
          codeHash: `0x${"00".repeat(32)}`,
          hashType: "type" as const,
          args: `0x${"44".repeat(32)}`,
        },
      },
    };
    const TYPE_ID_CODE_HASH = "0x00000000000000000000000000000000000000000000000000545950455f4944";
    profileCell.output.type.codeHash = TYPE_ID_CODE_HASH;
    expect(classifyCell(profileCell).kind).toBe("profile-cell");

    const dataCell = { ...messageCell, output: { ...messageCell.output, type: null } };
    expect(classifyCell(dataCell).kind).toBe("data-cell");
  });
});

describe("decryptPayloadView", () => {
  const alice = deriveIdentityKeys(
    mnemonicToSeed("legal winner thank year wave sausage worth useful legal winner thank yellow"),
  );
  const aliceProfileId = fill(0xaa, 32);
  const bobProfileId = fill(0xbb, 32);

  it("decrypts to structure by default, plaintext only on request", () => {
    const assembled = assembleTextMessage({
      text: "inspector test body",
      senderProfileId: bobProfileId,
      recipientProfileId: aliceProfileId,
      recipientKemPublicKey: alice.mlKem.publicKey,
      senderDeviceId: fill(0x01, 16),
    });
    const structural = decryptPayloadView({
      envelopeBytes: assembled.envelopeBytes,
      kemSecretKeyHex: Buffer.from(alice.mlKem.secretKey).toString("hex"),
      ownProfileIdHex: "aa".repeat(32),
      showPlaintext: false,
    });
    expect(structural.textLength).toBe("inspector test body".length);
    expect(structural.text).toBeUndefined();
    expect(structural.bodyType).toBe(0x01);

    const plain = decryptPayloadView({
      envelopeBytes: assembled.envelopeBytes,
      kemSecretKeyHex: Buffer.from(alice.mlKem.secretKey).toString("hex"),
      ownProfileIdHex: "aa".repeat(32),
      showPlaintext: true,
    });
    expect(plain.text).toBe("inspector test body");
  });

  it("rejects a wrong key without leaking anything", () => {
    const assembled = assembleTextMessage({
      text: "secret",
      senderProfileId: bobProfileId,
      recipientProfileId: aliceProfileId,
      recipientKemPublicKey: alice.mlKem.publicKey,
      senderDeviceId: fill(0x01, 16),
    });
    const wrongKey = deriveIdentityKeys(
      mnemonicToSeed(
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
      ),
    );
    expect(() =>
      decryptPayloadView({
        envelopeBytes: assembled.envelopeBytes,
        kemSecretKeyHex: Buffer.from(wrongKey.mlKem.secretKey).toString("hex"),
        ownProfileIdHex: "aa".repeat(32),
        showPlaintext: true,
      }),
    ).toThrow();
    wipeIdentityKeyBundle(wrongKey);
    wipeIdentityKeyBundle(alice);
  });
});
