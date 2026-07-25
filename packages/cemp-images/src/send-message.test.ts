import { assembleTextMessage } from "@cemp/ckb";
import { decryptEnvelope } from "@cemp/crypto";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { codec } from "@cemp/core";
import { describe, expect, it } from "vitest";
import { decryptAttachment, joinChunks } from "./encrypt.js";
import { checkManifest } from "./manifest.js";
import { publishImageMessage, type PublishImageMessageDeps } from "./send-message.js";
import {
  FakeCodec,
  FakeJournal,
  MESSAGE_TYPE_REF,
  fakeSourceImage,
  makeChain,
} from "./test-helpers.js";

/**
 * §6 key-coordination proof: publishImageMessage must generate ONE fresh KEM
 * encapsulation and reuse it for both the chunk-encryption key AND the
 * envelope's attachmentEnvelope override, so the recipient — decrypting the
 * envelope through the normal @cemp/crypto path — re-derives the exact key
 * the chunks were encrypted under. `publishText` itself is faked (message
 * publication is Task 13's concern); everything else runs the real pipeline
 * against the shared chain harness from test-helpers.ts.
 */
describe("publishImageMessage", () => {
  it("encrypts chunks under a key the receiver derives from the produced envelope", async () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const sender = new Uint8Array(32).fill(1);
    const recipient = new Uint8Array(32).fill(2);
    const senderDeviceId = new Uint8Array(16).fill(7);

    let counter = 0;
    const deterministicRandom = (n: number): Uint8Array => new Uint8Array(n).fill(++counter);

    const captured: { publishTextInput?: Record<string, unknown> } = {};
    const fakePublisher: PublishImageMessageDeps["publisher"] = {
      publishText: (input) => {
        // publishImageMessage wipes kemMessage in its `finally` AFTER this
        // call returns (correct hygiene — real callers must not retain a
        // reference beyond the call). Clone the buffers we want to inspect
        // once this promise settles, or the assertions below would read
        // zeroed-out memory.
        const envelope = input.attachmentEnvelope;
        captured.publishTextInput = {
          ...input,
          ...(envelope === undefined
            ? {}
            : {
                attachmentEnvelope: {
                  kemMessage: envelope.kemMessage.slice(),
                  nonce: envelope.nonce.slice(),
                },
              }),
        } as unknown as Record<string, unknown>;
        return Promise.resolve({
          txHash: "0xmsg",
          outPoint: { txHash: "0xmsg", index: 0 },
          committed: true,
          resumed: false,
        });
      },
    };

    const { client, signer, sentBodies } = makeChain();
    const journal = new FakeJournal();
    const source = fakeSourceImage(64, 48);

    const result = await publishImageMessage(
      {
        codec: new FakeCodec(),
        client,
        signer,
        messageType: MESSAGE_TYPE_REF,
        journal,
        publisher: fakePublisher,
        senderProfileId: sender,
        senderDeviceId,
        randomBytes: deterministicRandom,
      },
      {
        messageRowId: 1,
        logicalMessageId: "l1",
        recipientProfileIdHex: `0x${"02".repeat(32)}`,
        recipientKemPublicKey: publicKey,
        recipientProfileId: recipient,
        sourceBytes: source,
      },
    );

    // The message publish carried a 0x03 manifest + the coordination override
    // — the boundary that always pairs contentType with attachmentEnvelope.
    expect(captured.publishTextInput?.contentType).toBe(0x03);
    expect(captured.publishTextInput?.attachmentEnvelope).toBeDefined();
    expect(result.manifest).toBeDefined();
    expect(result.messageTxHash).toBe("0xmsg");
    expect(result.chunksTxHash).toBeDefined();
    expect(result.chunkCount).toBeGreaterThan(0);

    // THE LOAD-BEARING ASSERTION (proves §6): reassemble the envelope the
    // real publisher would have built, using the captured coordination
    // override, then decrypt it as the recipient — through the normal
    // @cemp/crypto envelope path, not by re-deriving the key directly.
    const attachmentEnvelope = captured.publishTextInput?.attachmentEnvelope as {
      kemMessage: Uint8Array;
      nonce: Uint8Array;
    };
    const assembled = assembleTextMessage({
      text: "",
      senderProfileId: sender,
      recipientProfileId: recipient,
      recipientKemPublicKey: publicKey,
      senderDeviceId,
      contentType: 0x03,
      attachmentManifests: [result.manifest],
      attachmentEnvelope,
    });
    const dec = decryptEnvelope({
      envelopeBytes: assembled.envelopeBytes,
      recipientKemSecretKey: secretKey,
      ownProfileId: recipient,
    });

    const manifest = codec.decodeAttachmentManifestV1(
      codec.encodeAttachmentManifestV1(result.manifest),
    );
    expect(checkManifest(manifest).ok).toBe(true);

    // Pull the actual committed chunk-cell ciphertext straight off the fake
    // chain (the only channel a black-box caller has to it) and decrypt with
    // the RECIPIENT-derived key — this is the exact key-consistency proof.
    expect(sentBodies).toHaveLength(1);
    const outputsData = sentBodies[0]!.outputs_data as string[];
    const chunks = outputsData.map((hex) => codec.hexToBytes(hex.slice(2)));
    const ciphertext = joinChunks(chunks);
    const plaintext = decryptAttachment(
      ciphertext,
      manifest.encryption_nonce,
      dec.attachmentKey,
      manifest.attachment_id,
    );
    expect(plaintext.length).toBe(Number(manifest.plaintext_size));

    // A wrong key must fail the GCM tag — proves the successful decrypt above
    // is actually exercising key correctness, not a no-op.
    expect(() =>
      decryptAttachment(
        ciphertext,
        manifest.encryption_nonce,
        new Uint8Array(32).fill(50),
        manifest.attachment_id,
      ),
    ).toThrow();
  });
});
