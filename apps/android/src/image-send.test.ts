/**
 * Unit tests for `runImageSend` (Task 13). Pure orchestration, no
 * react-native import anywhere in the module graph — a local fake codec
 * stands in for the platform bridge (the shared `@cemp/images` test-helpers'
 * `FakeCodec` is not importable here: the package only exposes its `"."`
 * export, so `@cemp/images/test-helpers.js` is outside the package's
 * `exports` map and Node's resolver rejects it).
 */
import { describe, expect, it, vi } from "vitest";
import { codec } from "@cemp/core";
import {
  ImageTooLargeError,
  buildAttachmentManifest,
  type DecodedImage,
  type ImageCodec,
  type ImageEncodeFormat,
  type PublishImageMessageInput,
} from "@cemp/images";
import { runImageSend, type RunImageSendDeps } from "./image-send.js";

// ── deterministic fake codec (mirrors @cemp/images/test-helpers' FakeCodec) ─

const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

function fakeEncoded(dims: { width: number; height: number }, quality: number): Uint8Array {
  const size = Math.max(
    WEBP_MAGIC.length + 16,
    Math.floor((dims.width * dims.height * quality) / 400),
  );
  const bytes = new Uint8Array(size);
  bytes.set(WEBP_MAGIC, 0);
  for (let i = WEBP_MAGIC.length; i < size; i++) {
    bytes[i] = (i * 31 + quality) % 251;
  }
  return bytes;
}

function fakeSourceImage(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(WEBP_MAGIC.length + 4);
  bytes.set(WEBP_MAGIC, 0);
  bytes[WEBP_MAGIC.length] = (width >> 8) & 0xff;
  bytes[WEBP_MAGIC.length + 1] = width & 0xff;
  bytes[WEBP_MAGIC.length + 2] = (height >> 8) & 0xff;
  bytes[WEBP_MAGIC.length + 3] = height & 0xff;
  return bytes;
}

class FakeCodec implements ImageCodec {
  decode(bytes: Uint8Array): Promise<DecodedImage> {
    const width = (bytes[WEBP_MAGIC.length]! << 8) | bytes[WEBP_MAGIC.length + 1]!;
    const height = (bytes[WEBP_MAGIC.length + 2]! << 8) | bytes[WEBP_MAGIC.length + 3]!;
    return Promise.resolve({ width, height, pixels: bytes });
  }

  resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> {
    return Promise.resolve({ width, height, pixels: image.pixels });
  }

  encode(image: DecodedImage, _format: ImageEncodeFormat, quality: number): Promise<Uint8Array> {
    return Promise.resolve(fakeEncoded({ width: image.width, height: image.height }, quality));
  }
}

/** A codec whose encoded output never shrinks — forces ImageTooLargeError. */
class AlwaysHugeCodec implements ImageCodec {
  decode(bytes: Uint8Array): Promise<DecodedImage> {
    const width = (bytes[WEBP_MAGIC.length]! << 8) | bytes[WEBP_MAGIC.length + 1]!;
    const height = (bytes[WEBP_MAGIC.length + 2]! << 8) | bytes[WEBP_MAGIC.length + 3]!;
    return Promise.resolve({ width, height, pixels: bytes });
  }

  resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> {
    return Promise.resolve({ width, height, pixels: image.pixels });
  }

  encode(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(2_000_000));
  }
}

const RECIPIENT_PROFILE_ID_HEX = "ab".repeat(32);

function baseInput(sourceBytes: Uint8Array) {
  return {
    messageRowId: 7,
    logicalMessageId: "logical-1",
    recipientProfileIdHex: RECIPIENT_PROFILE_ID_HEX,
    recipientKemPublicKey: new Uint8Array(32),
    recipientProfileId: new Uint8Array(32).fill(1),
    sourceBytes,
  };
}

function baseDeps(overrides: Partial<RunImageSendDeps> = {}): RunImageSendDeps {
  return {
    codec: new FakeCodec(),
    availableShannon: 1_000_000n * 100_000_000n,
    perChunkShannon: 33_000n * 100_000_000n,
    messageCellShannon: 20_000n * 100_000_000n,
    feeReserveShannon: 1n * 100_000_000n,
    publish: vi.fn(),
    attachments: { create: vi.fn() },
    ...overrides,
  };
}

describe("runImageSend capacity pre-flight (5A)", () => {
  it("throws a jargon-free error and never publishes when the wallet can't cover it", async () => {
    const publish = vi.fn();
    const deps = baseDeps({ availableShannon: 100n, publish });

    await expect(runImageSend(deps, baseInput(fakeSourceImage(640, 480)))).rejects.toThrow(
      /not enough balance/i,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes and records the local attachment row on a sufficiently funded send", async () => {
    const manifest = buildAttachmentManifest({
      attachmentId: new Uint8Array(16).fill(2),
      chunkOutpoints: [{ txHash: `0x${"cc".repeat(32)}`, index: 0 }],
      encryptedSize: 999 + 16,
      plaintextSize: 999,
      mimeType: "image/webp",
      width: 640,
      height: 480,
      contentHash: new Uint8Array(32).fill(3),
      cipherHash: new Uint8Array(32).fill(4),
      encryptionNonce: new Uint8Array(12).fill(5),
      reclaimGroupId: new Uint8Array(16).fill(6),
    });
    const publish = vi.fn().mockResolvedValue({
      chunksTxHash: "0xchunks",
      messageTxHash: "0xmessage",
      manifest,
      chunkCount: 1,
      plaintextSize: 999,
    });
    const attachmentsCreate = vi.fn().mockResolvedValue({});
    const deps = baseDeps({ publish, attachments: { create: attachmentsCreate } });

    const input = baseInput(fakeSourceImage(640, 480));
    const result = await runImageSend(deps, input);

    expect(publish).toHaveBeenCalledTimes(1);
    // The pre-flight's prepared image is threaded into the publish input, so
    // publishImageMessage skips its own prepareImage (single compression).
    const publishInput = publish.mock.calls[0]![0] as PublishImageMessageInput;
    expect(publishInput).toMatchObject(input);
    expect(publishInput.preparedImage).toBeDefined();
    expect(publishInput.preparedImage!.bytes.length).toBeGreaterThan(0);
    expect(result).toEqual({ messageTxHash: "0xmessage", chunksTxHash: "0xchunks" });

    expect(attachmentsCreate).toHaveBeenCalledTimes(1);
    const call = attachmentsCreate.mock.calls[0]![0] as {
      messageId: number;
      kind: string;
      byteLength: number;
      manifest: Uint8Array;
    };
    expect(call.messageId).toBe(input.messageRowId);
    expect(call.kind).toBe("image");
    expect(call.byteLength).toBe(999);
    expect(call.manifest).toEqual(codec.encodeAttachmentManifestV1(manifest));
  });

  it("maps ImageTooLargeError to a jargon-free message and never publishes", async () => {
    const publish = vi.fn();
    const deps = baseDeps({ codec: new AlwaysHugeCodec(), publish });

    await expect(runImageSend(deps, baseInput(fakeSourceImage(1200, 1200)))).rejects.toThrow(
      /too large/i,
    );
    expect(publish).not.toHaveBeenCalled();
  });
});

it("sanity: AlwaysHugeCodec really does trip ImageTooLargeError upstream", async () => {
  // Documents WHY the fixture works, independent of runImageSend's mapping.
  const { prepareImage } = await import("@cemp/images");
  await expect(
    prepareImage(new AlwaysHugeCodec(), fakeSourceImage(1200, 1200)),
  ).rejects.toBeInstanceOf(ImageTooLargeError);
});
