/**
 * Attachment receive pipeline (spec §9.4, Phase 10 tasks 11–12).
 *
 * Manifest is validated BEFORE anything is fetched (task 11), chunks are
 * downloaded positionally, the reassembled ciphertext is hash-checked, then
 * decrypted, and the plaintext is hash-checked and magic-sniffed against the
 * declared mime. Any failure throws — nothing partially decoded reaches the
 * caller (rule 4).
 */

import type { CempClient } from "@cemp/ckb";
import { codec } from "@cemp/core";
import { sniffImageFormat } from "./codec.js";
import { ATTACHMENT_CHUNK_BYTES, blake2b256, decryptAttachment, joinChunks } from "./encrypt.js";
import { checkManifest } from "./manifest.js";

export interface DownloadedAttachment {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly thumbnail: Uint8Array | null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  // Review C2: strict — never truncate/coerce hostile or malformed input.
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (bare.length % 2 !== 0 || !/^[0-9a-f]*$/.test(bare)) {
    throw new Error("hexToBytes: expected even-length lowercase hex");
  }
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/**
 * Download + validate + decrypt one attachment. `attachmentKey` comes from
 * the envelope decryption (never from the manifest or the chain).
 */
export async function downloadAttachment(
  client: CempClient,
  manifest: codec.AttachmentManifestV1,
  attachmentKey: Uint8Array,
): Promise<DownloadedAttachment> {
  // Task 11: declared sizes/limits before any fetch (decompression-bomb guard).
  const check = checkManifest(manifest);
  if (!check.ok) {
    throw new Error(`attachment manifest rejected: ${check.reason}`);
  }

  const chunks: Uint8Array[] = [];
  for (const [i, outpoint] of manifest.chunk_outpoints.entries()) {
    const status = await client.getLiveCell({
      txHash: `0x${bytesToHex(outpoint.tx_hash)}`,
      index: `0x${outpoint.index.toString(16)}`,
    });
    if (status.status !== "live") {
      throw new Error(`attachment chunk ${String(i)} is not live (reclaimed or pruned)`);
    }
    const chunkData = hexToBytes(status.cell.data);
    // A hostile chunk cell can declare arbitrary data — cap each chunk to
    // the protocol chunk size BEFORE it joins memory (task 11 / bomb guard).
    if (chunkData.length > ATTACHMENT_CHUNK_BYTES) {
      throw new Error(
        `attachment chunk ${String(i)} carries ${chunkData.length} bytes, above the ${String(ATTACHMENT_CHUNK_BYTES)}-byte chunk limit`,
      );
    }
    chunks.push(chunkData);
  }
  const ciphertext = joinChunks(chunks);
  if (BigInt(ciphertext.length) !== manifest.encrypted_size) {
    throw new Error(
      `reassembled ciphertext is ${ciphertext.length} bytes, manifest declares ${manifest.encrypted_size}`,
    );
  }
  // Validate encrypted chunk integrity (spec §9.4 step 4).
  if (bytesToHex(blake2b256(ciphertext)) !== bytesToHex(manifest.cipher_hash)) {
    throw new Error("ciphertext hash mismatch — chunks are corrupt or hostile");
  }

  const plaintext = decryptAttachment(
    ciphertext,
    manifest.encryption_nonce,
    attachmentKey,
    manifest.attachment_id,
  );
  if (BigInt(plaintext.length) !== manifest.plaintext_size) {
    throw new Error("decrypted size does not match the manifest");
  }
  // Validate the plaintext content hash (spec §9.4 step 7).
  if (bytesToHex(blake2b256(plaintext)) !== bytesToHex(manifest.content_hash)) {
    throw new Error("plaintext content hash mismatch");
  }
  const declaredMime = new TextDecoder().decode(manifest.mime_type);
  const sniffed = sniffImageFormat(plaintext);
  const sniffedMime = sniffed === "unknown" ? "unknown" : `image/${sniffed}`;
  if (sniffedMime !== declaredMime) {
    throw new Error(`plaintext is ${sniffedMime}, manifest declares ${declaredMime}`);
  }
  return {
    bytes: plaintext,
    mimeType: declaredMime,
    width: manifest.width,
    height: manifest.height,
    thumbnail: manifest.thumbnail ?? null,
  };
}
