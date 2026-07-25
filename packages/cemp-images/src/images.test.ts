import { Cell, CellOutput, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { buildMessageTypeArgs, MlDsaV2TxSigner } from "@cemp/ckb";
import { MockCkbClient, fillHex, toOutputLike } from "@cemp/ckb/testing";
import { describe, expect, it } from "vitest";
import { compressToLimits, ImageTooLargeError } from "./compress.js";
import {
  ATTACHMENT_CHUNK_BYTES,
  decryptAttachment,
  encryptAttachment,
  joinChunks,
  splitIntoChunks,
} from "./encrypt.js";
import { DEFAULT_IMAGE_LIMITS, planImageFit, planThumbnailFit } from "./limits.js";
import { buildAttachmentManifest, checkManifest } from "./manifest.js";
import { codec } from "@cemp/core";
import {
  buildManifestForCommittedChunks,
  prepareAttachmentChunks,
  publishAttachmentChunks,
} from "./send.js";
import { downloadAttachment } from "./receive.js";
import { reclaimAttachmentGroup } from "./reclaim.js";
import {
  FakeCodec,
  FakeJournal,
  MESSAGE_TYPE_REF,
  chunkCellsFromBody,
  fakeEncoded,
  fakeSourceImage,
  keyPair,
  makeChain,
} from "./test-helpers.js";
import type { DecodedImage, ImageCodec } from "./codec.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Phase 10 image pipeline (offline): limits/compress policy, encryption +
 * chunking, manifest construction/validation, chunk publish with journal,
 * download/decrypt, group reclaim. A deterministic FakeCodec drives the
 * platform-neutral policy; pixel-level codecs are platform seams (rule 14).
 * Chain + codec fixtures live in `./test-helpers.js`, shared with
 * `send-message.test.ts`.
 */

// ── limits + compression policy ────────────────────────────────────────────

describe("limits + compress policy (tasks 3, 5)", () => {
  it("planImageFit downscales aspect-preserving, never upscales", () => {
    expect(planImageFit({ width: 2560, height: 1280 }, 1280)).toEqual({ width: 1280, height: 640 });
    expect(planImageFit({ width: 1280, height: 2560 }, 1280)).toEqual({ width: 640, height: 1280 });
    expect(planImageFit({ width: 800, height: 600 }, 1280)).toEqual({ width: 800, height: 600 });
    expect(planImageFit({ width: 3000, height: 1000 }, 960).width).toBe(960);
    expect(planThumbnailFit({ width: 1280, height: 960 })).toEqual({ width: 320, height: 240 });
    expect(() => planImageFit({ width: 0, height: 100 }, 1280)).toThrow();
  });

  it("compresses to the preferred target, retreating quality then dimensions", async () => {
    const codecImpl = new FakeCodec();
    const image: DecodedImage = { width: 2400, height: 1600, pixels: null };
    const result = await compressToLimits(codecImpl, image, "webp");
    expect(result.bytes.length).toBeLessThanOrEqual(DEFAULT_IMAGE_LIMITS.preferredAttachmentBytes);
    expect(result.dimensions.width / result.dimensions.height).toBeCloseTo(2400 / 1600, 2);
    expect(codecImpl.encodeCalls.length).toBeGreaterThan(0);
  });

  it("throws ImageTooLargeError when nothing fits (task 5)", async () => {
    class HugeCodec implements ImageCodec {
      decode(): Promise<DecodedImage> {
        throw new Error("unused");
      }
      resize(image: DecodedImage): Promise<DecodedImage> {
        return Promise.resolve(image);
      }
      encode(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(DEFAULT_IMAGE_LIMITS.maxAttachmentBytes + 1));
      }
    }
    await expect(
      compressToLimits(new HugeCodec(), { width: 4000, height: 3000, pixels: null }, "webp"),
    ).rejects.toBeInstanceOf(ImageTooLargeError);
  });
});

// ── encryption + chunking (tasks 7, 8) ─────────────────────────────────────

describe("encrypt + chunks", () => {
  const key = new Uint8Array(32).fill(7);

  it("round-trips encrypt → split → join → decrypt; rejects tampering", () => {
    const plaintext = fakeEncoded({ width: 100, height: 80 }, 80);
    const encrypted = encryptAttachment(plaintext, key);
    expect(encrypted.ciphertext.length).toBe(plaintext.length + 16);
    const chunks = splitIntoChunks(encrypted.ciphertext);
    const reassembled = joinChunks(chunks);
    expect(reassembled).toEqual(encrypted.ciphertext);
    expect(decryptAttachment(reassembled, encrypted.nonce, key, encrypted.attachmentId)).toEqual(
      plaintext,
    );

    const tampered = reassembled.slice();
    tampered[10] = tampered[10]! ^ 1;
    expect(() =>
      decryptAttachment(tampered, encrypted.nonce, key, encrypted.attachmentId),
    ).toThrow();
    expect(() =>
      decryptAttachment(
        reassembled,
        encrypted.nonce,
        new Uint8Array(32).fill(8),
        encrypted.attachmentId,
      ),
    ).toThrow();
  });

  it("a 1 MiB ciphertext is at most 32 chunks", () => {
    const chunks = splitIntoChunks(new Uint8Array(1024 * 1024).fill(1));
    expect(chunks.length).toBeLessThanOrEqual(32);
    expect(chunks[0]!.length).toBe(ATTACHMENT_CHUNK_BYTES);
    expect(chunks.at(-1)!.length).toBeLessThanOrEqual(ATTACHMENT_CHUNK_BYTES);
    expect(() => splitIntoChunks(new Uint8Array(0))).toThrow();
  });
});

// ── manifest build + validation (tasks 9, 11) ──────────────────────────────

function validManifestInput(): Parameters<typeof buildAttachmentManifest>[0] {
  const encryptedSize = 50_000;
  return {
    attachmentId: new Uint8Array(16).fill(1),
    chunkOutpoints: [
      { txHash: `0x${"aa".repeat(32)}`, index: 0 },
      { txHash: `0x${"aa".repeat(32)}`, index: 1 },
    ],
    encryptedSize,
    plaintextSize: encryptedSize - 16,
    mimeType: "image/webp",
    width: 960,
    height: 640,
    thumbnail: new Uint8Array(100).fill(2),
    contentHash: new Uint8Array(32).fill(3),
    cipherHash: new Uint8Array(32).fill(4),
    encryptionNonce: new Uint8Array(12).fill(5),
    reclaimGroupId: new Uint8Array(16).fill(6),
  };
}

describe("manifest", () => {
  it("builds a codec round-trippable manifest and passes validation", () => {
    const manifest = buildAttachmentManifest(validManifestInput());
    const decoded = codec.decodeAttachmentManifestV1(codec.encodeAttachmentManifestV1(manifest));
    expect(checkManifest(decoded).ok).toBe(true);
    expect(decoded.width).toBe(960);
    expect(decoded.chunk_outpoints).toHaveLength(2);
    expect(decoded.ckbfs_root.index).toBe(0);
  });

  it("rejects hostile declarations BEFORE download (task 11)", () => {
    const base = validManifestInput();
    const check = (
      patch: Partial<Parameters<typeof buildAttachmentManifest>[0]>,
    ): string | undefined => {
      const manifest = codec.decodeAttachmentManifestV1(
        codec.encodeAttachmentManifestV1(buildAttachmentManifest({ ...base, ...patch })),
      );
      return checkManifest(manifest).reason;
    };
    // Decompression bomb (spec Phase 11 task 5, guarded here).
    expect(check({ plaintextSize: DEFAULT_IMAGE_LIMITS.maxAttachmentBytes + 1 })).toMatch(/limit/);
    expect(check({ encryptedSize: base.plaintextSize + 32 })).toMatch(/GCM tag/);
    expect(check({ chunkOutpoints: [base.chunkOutpoints[0]!] })).toMatch(/chunk count/);
    expect(check({ width: 0 })).toMatch(/zero/);
    expect(check({ width: 2000, height: 2000 })).toMatch(/longest-edge/);
    expect(check({ thumbnail: new Uint8Array(40_000) })).toMatch(/thumbnail/);
    expect(check({ mimeType: "image/gif" })).toMatch(/mime/);
  });
});

// ── chain fixtures ─────────────────────────────────────────────────────────
// (FakeJournal, MESSAGE_TYPE_REF, makeChain, chunkCellsFromBody — see
// ./test-helpers.js, shared with send-message.test.ts)

// ── send + receive e2e (tasks 7–12) ────────────────────────────────────────

describe("attachment send + receive (e2e offline)", () => {
  it("prepares, publishes chunks with journal, builds manifest, downloads and decrypts", async () => {
    const attachmentKey = new Uint8Array(32).fill(11);
    const { client, signer, sentBodies } = makeChain();
    const journal = new FakeJournal();

    // Phase A: prepare → encrypt → chunk (2400×1600 source).
    const chunks = await prepareAttachmentChunks(
      new FakeCodec(),
      fakeSourceImage(800, 600, 10_000),
      attachmentKey,
    );
    expect(chunks.chunks.length).toBeGreaterThan(0);
    expect(chunks.prepared.mimeType).toBe("image/webp");
    // No plaintext on-chain: every chunk is a ciphertext slice (task exit 2).
    for (const chunk of chunks.chunks) {
      expect(chunk).not.toEqual(chunks.prepared.bytes.slice(0, chunk.length));
    }

    // Publish: journal BEFORE broadcast, then commit.
    const published = await publishAttachmentChunks(
      { client, signer, journal, messageType: MESSAGE_TYPE_REF },
      chunks,
    );
    expect(published.resumed).toBe(false);
    expect(sentBodies).toHaveLength(1);
    const journaled = [...journal.txs.values()][0]!;
    expect(journaled.purpose.startsWith("attachment-chunks:")).toBe(true);
    expect(journaled.state).toBe("committed");

    // Crash-resume: a journaled-but-uncommitted tx is adopted (no re-upload).
    const crashed = new FakeJournal();
    crashed.txs.set(published.chunksTxHash, {
      txHash: published.chunksTxHash,
      state: "submitted",
      purpose: journaled.purpose,
    });
    const again = await publishAttachmentChunks(
      { client, signer, journal: crashed, messageType: MESSAGE_TYPE_REF },
      chunks,
    );
    expect(again.resumed).toBe(true);
    expect(sentBodies).toHaveLength(1);

    // Phase B: manifest from the committed outpoints.
    const manifestEncodable = buildManifestForCommittedChunks({
      chunks,
      chunksTxHash: published.chunksTxHash,
      reclaimGroupId: new Uint8Array(16).fill(6),
    });
    const manifest = codec.decodeAttachmentManifestV1(
      codec.encodeAttachmentManifestV1(manifestEncodable),
    );
    expect(checkManifest(manifest).ok).toBe(true);

    // Receive: the committed chunk cells are live; download + decrypt.
    const liveCells = chunkCellsFromBody(sentBodies[0]!, signer);
    const { client: liveClient } = makeChain(liveCells);
    const downloaded = await downloadAttachment(liveClient, manifest, attachmentKey);
    expect(downloaded.bytes).toEqual(chunks.prepared.bytes);
    expect(downloaded.mimeType).toBe("image/webp");
    expect(downloaded.width).toBe(chunks.prepared.width);
    expect(downloaded.thumbnail).not.toBeNull();

    // Wrong key fails; a tampered chunk fails the cipher hash check.
    await expect(
      downloadAttachment(liveClient, manifest, new Uint8Array(32).fill(12)),
    ).rejects.toThrow();
    const tamperedCells = new Map(liveCells);
    const firstKey = [...liveCells.keys()][0]!;
    const firstCell = tamperedCells.get(firstKey)!;
    tamperedCells.set(
      firstKey,
      Cell.from({
        outPoint: firstCell.outPoint,
        cellOutput: toOutputLike(firstCell.cellOutput),
        outputData: "0xdeadbeef",
      }),
    );
    const { client: tamperedClient } = makeChain(tamperedCells);
    await expect(downloadAttachment(tamperedClient, manifest, attachmentKey)).rejects.toThrow();
  });

  it("abandons a rejected journaled chunk tx and rebuilds with fresh inputs (T17 F-1)", async () => {
    const attachmentKey = new Uint8Array(32).fill(11);
    const deadHash = fillHex(0xde, 32);
    const { client, signer, sentBodies } = makeChain(new Map(), {
      rejectedTxHashes: new Set([deadHash]),
    });
    const journal = new FakeJournal();
    const chunks = await prepareAttachmentChunks(
      new FakeCodec(),
      fakeSourceImage(800, 600, 10_000),
      attachmentKey,
    );

    // The exact wedged state T17 hit on-device: a submitted chunk tx the
    // network rejected (built over an already-spent input).
    const purpose = `attachment-chunks:${bytesToHex(chunks.encrypted.attachmentId)}`;
    journal.txs.set(deadHash, { txHash: deadHash, state: "submitted", purpose });

    const result = await publishAttachmentChunks(
      { client, signer, journal, messageType: MESSAGE_TYPE_REF },
      chunks,
    );
    expect(result.resumed).toBe(false);
    // The dead tx is abandoned (never rebroadcast) and a FRESH tx is built,
    // journaled under the same purpose and committed.
    expect(journal.txs.get(deadHash)!.state).toBe("abandoned");
    expect(sentBodies).toHaveLength(1);
    const replacement = [...journal.txs.values()].find((t) => t.txHash !== deadHash)!;
    expect(replacement.purpose).toBe(purpose);
    expect(replacement.state).toBe("committed");
    expect(result.chunksTxHash).toBe(replacement.txHash);
  });
});

// ── group reclaim (tasks 14–15) ────────────────────────────────────────────

describe("reclaimAttachmentGroup (task 14)", () => {
  it("reclaims message + chunk cells in one tx and releases capacity", async () => {
    const { signer } = makeChain();
    const typeArgs = buildMessageTypeArgs(
      new Uint8Array(32).fill(1),
      new Uint8Array(16).fill(2),
      new Uint8Array(16).fill(3),
    );
    const messageCell = Cell.from({
      outPoint: { txHash: fillHex(0xc1, 32), index: 0 },
      cellOutput: toOutputLike(
        CellOutput.from({
          capacity: fixedPointFrom(500),
          lock: signer.lockScript(),
          type: {
            codeHash: MESSAGE_TYPE_REF.codeHash,
            hashType: MESSAGE_TYPE_REF.hashType,
            args: hexFrom(typeArgs),
          },
        }),
      ),
      outputData: "0x1234",
    });
    const chunkCell = (seed: number) =>
      Cell.from({
        outPoint: { txHash: fillHex(seed, 32), index: 0 },
        cellOutput: toOutputLike(
          CellOutput.from({ capacity: fixedPointFrom(300), lock: signer.lockScript() }),
        ),
        outputData: "0xbeef",
      });
    const liveCells = new Map<string, Cell>([
      [`${messageCell.outPoint.txHash}:0`, messageCell],
      [`${fillHex(0xc2, 32)}:0`, chunkCell(0xc2)],
      [`${fillHex(0xc3, 32)}:0`, chunkCell(0xc3)],
    ]);
    const { client } = makeChain(liveCells);
    // The signer's CCC chain must resolve the reclaimed cells + fee inputs.
    const mockChain = new MockCkbClient();
    const fundedSigner = new MlDsaV2TxSigner({ keyPair, client: mockChain });
    mockChain.addCells(
      messageCell,
      chunkCell(0xc2),
      chunkCell(0xc3),
      Cell.from({
        outPoint: { txHash: fillHex(0xf2, 32), index: 1 },
        cellOutput: toOutputLike(
          CellOutput.from({ capacity: fixedPointFrom(2000), lock: fundedSigner.lockScript() }),
        ),
        outputData: "0x",
      }),
    );
    const store = new FakeJournal();

    const result = await reclaimAttachmentGroup(
      { client, signer: fundedSigner, messageType: MESSAGE_TYPE_REF, store },
      new Uint8Array(16).fill(6),
      [
        { txHash: messageCell.outPoint.txHash, index: "0x0" },
        { txHash: fillHex(0xc2, 32), index: "0x0" },
        { txHash: fillHex(0xc3, 32), index: "0x0" },
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.cellCount).toBe(3);
    expect(result!.resumed).toBe(false);
    expect(store.released).toHaveLength(1);
    expect(BigInt(store.released[0]!)).toBe(fixedPointFrom(1100));
    const journaled = [...store.txs.values()][0]!;
    expect(journaled.purpose.startsWith("reclaim-attachment:")).toBe(true);
    expect(journaled.state).toBe("committed");
  });
});

describe("hostile chunk cells (Phase 11 tasks 4–6)", () => {
  it("rejects a chunk cell carrying more than the chunk limit BEFORE joining", async () => {
    const attachmentKey = new Uint8Array(32).fill(11);
    const { signer } = makeChain();
    const { client, sentBodies } = makeChain();
    const journal = new FakeJournal();
    const chunks = await prepareAttachmentChunks(
      new FakeCodec(),
      fakeSourceImage(800, 600, 10_000),
      attachmentKey,
    );
    const published = await publishAttachmentChunks(
      { client, signer, journal, messageType: MESSAGE_TYPE_REF },
      chunks,
    );
    const manifestEncodable = buildManifestForCommittedChunks({
      chunks,
      chunksTxHash: published.chunksTxHash,
      reclaimGroupId: new Uint8Array(16).fill(6),
    });
    const manifest = codec.decodeAttachmentManifestV1(
      codec.encodeAttachmentManifestV1(manifestEncodable),
    );

    // Poison the FIRST chunk cell with an oversized payload.
    const liveCells = chunkCellsFromBody(sentBodies[0]!, signer);
    const firstKey = [...liveCells.keys()][0]!;
    const firstCell = liveCells.get(firstKey)!;
    liveCells.set(
      firstKey,
      Cell.from({
        outPoint: firstCell.outPoint,
        cellOutput: toOutputLike(firstCell.cellOutput),
        outputData: hexFrom(new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1).fill(0xaa)),
      }),
    );
    const { client: hostileClient } = makeChain(liveCells);
    await expect(downloadAttachment(hostileClient, manifest, attachmentKey)).rejects.toThrow(
      /chunk limit/,
    );
  });
});
