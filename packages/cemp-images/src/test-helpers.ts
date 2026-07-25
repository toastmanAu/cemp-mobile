/**
 * Shared test fixtures for `@cemp/images` (Phase 10 + image-send
 * orchestration tests). A deterministic `FakeCodec` drives the
 * platform-neutral policy; a fake CKB chain (client/signer/journal) mirrors
 * the real `CempClient`/`MlDsaV2TxSigner` surface for offline chunk-tx
 * publish + live-cell reads. Extracted from `images.test.ts` so
 * `send-message.test.ts` can reuse the exact same harness (DRY — no parallel
 * chain fake).
 */

import { Cell, CellOutput, fixedPointFrom } from "@ckb-ccc/core";
import { CKB_TESTNET } from "@cemp/core";
import { mldsaV2KeygenFromSeed } from "@cemp/crypto";
import { CempClient, type CempMessageTypeRef, MlDsaV2TxSigner } from "@cemp/ckb";
import { MockCkbClient, fillHex, hashFromRpcBody, toOutputLike } from "@cemp/ckb/testing";
import type { JsonRpcTransport } from "@cemp/ckb";
import type { DecodedImage, ImageCodec, ImageEncodeFormat } from "./codec.js";
import type { AttachmentChunkJournal } from "./send.js";
import type { AttachmentReclaimStore } from "./reclaim.js";

// ── deterministic fake codec ───────────────────────────────────────────────

const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

export function fakeEncoded(dims: { width: number; height: number }, quality: number): Uint8Array {
  // Deterministic size model: area × quality factor, floored at the magic.
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

export class FakeCodec implements ImageCodec {
  readonly resizeCalls: { width: number; height: number }[] = [];
  readonly encodeCalls: { format: ImageEncodeFormat; quality: number }[] = [];

  decode(bytes: Uint8Array): Promise<DecodedImage> {
    // Source convention in tests: first 4 bytes after magic encode w,h.
    const width = (bytes[WEBP_MAGIC.length]! << 8) | bytes[WEBP_MAGIC.length + 1]!;
    const height = (bytes[WEBP_MAGIC.length + 2]! << 8) | bytes[WEBP_MAGIC.length + 3]!;
    return Promise.resolve({ width, height, pixels: bytes });
  }

  resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> {
    this.resizeCalls.push({ width, height });
    return Promise.resolve({ width, height, pixels: image.pixels });
  }

  encode(image: DecodedImage, format: ImageEncodeFormat, quality: number): Promise<Uint8Array> {
    this.encodeCalls.push({ format, quality });
    return Promise.resolve(fakeEncoded({ width: image.width, height: image.height }, quality));
  }
}

/** A FakeCodec-decodable fixture: WEBP magic + width/height header + padding. */
export function fakeSourceImage(width: number, height: number, extraBytes = 0): Uint8Array {
  const bytes = new Uint8Array(WEBP_MAGIC.length + 4 + extraBytes);
  bytes.set(WEBP_MAGIC, 0);
  bytes[WEBP_MAGIC.length] = (width >> 8) & 0xff;
  bytes[WEBP_MAGIC.length + 1] = width & 0xff;
  bytes[WEBP_MAGIC.length + 2] = (height >> 8) & 0xff;
  bytes[WEBP_MAGIC.length + 3] = height & 0xff;
  return bytes;
}

// ── chain fixtures ─────────────────────────────────────────────────────────

export const keyPair = mldsaV2KeygenFromSeed(new Uint8Array(32).fill(9));
export const MESSAGE_TYPE_REF: CempMessageTypeRef = {
  codeHash: CKB_TESTNET.deployments.cempMessageType!.codeHash,
  hashType: CKB_TESTNET.deployments.cempMessageType!.hashType,
  cellDep: {
    txHash: CKB_TESTNET.deployments.cempMessageType!.txHash,
    index: "0x0",
    depType: "code",
  },
};

export class FakeJournal implements AttachmentChunkJournal, AttachmentReclaimStore {
  readonly txs = new Map<
    string,
    { txHash: string; state: string; purpose: string; capacityShannon?: string }
  >();
  released: string[] = [];

  recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    capacityShannon?: string;
  }): Promise<void> {
    this.txs.set(input.txHash, { ...input });
    return Promise.resolve();
  }

  markOutgoingTxState(txHash: string, state: string): Promise<void> {
    this.txs.get(txHash)!.state = state;
    return Promise.resolve();
  }

  findLatestOutgoingTxByPurposePrefix(prefix: string) {
    const found = [...this.txs.values()].filter((t) => t.purpose.startsWith(prefix)).at(-1);
    return Promise.resolve(found);
  }

  releaseReclaimedCapacity(amount: string): Promise<void> {
    this.released.push(amount);
    return Promise.resolve();
  }
}

export function makeChain(
  liveCells: Map<string, Cell> = new Map(),
  opts: { rejectedTxHashes?: ReadonlySet<string> } = {},
): {
  client: CempClient;
  signer: MlDsaV2TxSigner;
  sentBodies: Record<string, unknown>[];
} {
  const sentBodies: Record<string, unknown>[] = [];
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
              data: { content: cell.outputData, hash: fillHex(0, 32) },
            },
            status: "live",
          });
        }
        case "send_transaction":
          sentBodies.push(params[0] as Record<string, unknown>);
          return Promise.resolve(hashFromRpcBody(params[0] as Record<string, unknown>));
        case "get_transaction": {
          const hash = params[0] as string;
          if (opts.rejectedTxHashes?.has(hash)) {
            return Promise.resolve({
              tx_status: { status: "rejected", reason: "Resolve failed Unknown(OutPoint)" },
            });
          }
          return Promise.resolve({
            tx_status: { status: "committed", block_hash: fillHex(0x99, 32) },
          });
        }
        case "get_header":
          return Promise.resolve({
            number: "0x100",
            epoch: "0x0",
            timestamp: "0x0",
            hash: fillHex(0x99, 32),
          });
        default:
          return Promise.reject(new Error(`unexpected method ${method}`));
      }
    },
  };
  const mockChain = new MockCkbClient();
  const signer = new MlDsaV2TxSigner({ keyPair, client: mockChain });
  mockChain.addCells(
    Cell.from({
      outPoint: { txHash: fillHex(0xf1, 32), index: 0 },
      cellOutput: toOutputLike(
        CellOutput.from({ capacity: fixedPointFrom(250_000), lock: signer.lockScript() }),
      ),
      outputData: "0x",
    }),
  );
  return { client: new CempClient({ transport }), signer, sentBodies };
}

export function chunkCellsFromBody(
  body: Record<string, unknown>,
  signer: MlDsaV2TxSigner,
): Map<string, Cell> {
  const txHash = hashFromRpcBody(body);
  const outputs = body.outputs as { capacity: string }[];
  const outputsData = body.outputs_data as string[];
  const map = new Map<string, Cell>();
  outputs.forEach((_, index) => {
    map.set(
      `${txHash}:${String(index)}`,
      Cell.from({
        outPoint: { txHash, index },
        cellOutput: toOutputLike(
          CellOutput.from({
            capacity: BigInt(outputs[index]!.capacity),
            lock: signer.lockScript(),
          }),
        ),
        outputData: outputsData[index]!,
      }),
    );
  });
  return map;
}
