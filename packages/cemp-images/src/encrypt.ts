/**
 * Attachment encryption (spec §9.2, Phase 10 task 7) and chunking (task 8).
 *
 * The resized+re-encoded image is encrypted ONCE under the envelope-derived
 * attachment key (AES-256-GCM, random nonce, AAD = attachment id) BEFORE any
 * chunk exists — CKBFS cells only ever carry ciphertext ("CKBFS should never
 * receive plaintext private images"). Chunks are then a trivial fixed-size
 * split of the ciphertext; order is positional, integrity is the GCM tag +
 * the manifest's cipher_hash.
 */

import { ckbHash } from "@cemp/core";
import { aes256GcmDecrypt, aes256GcmEncrypt, randomBytes } from "@cemp/crypto";

/** Fixed chunk payload size (32 KiB — a 1 MB image is at most 32 cells). */
export const ATTACHMENT_CHUNK_BYTES = 32_768;

const AAD_PREFIX = "CEMP/ATTACHMENT/v1";
const textEncoder = new TextEncoder();

function aadFor(attachmentId: Uint8Array): Uint8Array {
  const prefix = textEncoder.encode(AAD_PREFIX);
  const out = new Uint8Array(prefix.length + attachmentId.length);
  out.set(prefix, 0);
  out.set(attachmentId, prefix.length);
  return out;
}

export interface EncryptedAttachment {
  readonly attachmentId: Uint8Array;
  readonly nonce: Uint8Array;
  /** ciphertext ‖ 16-byte GCM tag, chunked by {@link splitIntoChunks}. */
  readonly ciphertext: Uint8Array;
  /** blake2b-256 of the ciphertext (the manifest's cipher_hash). */
  readonly cipherHash: Uint8Array;
}

/** Encrypt a prepared image. Key comes from the envelope (attachmentKey). */
export function encryptAttachment(
  plaintext: Uint8Array,
  attachmentKey: Uint8Array,
  attachmentId: Uint8Array = randomBytes(16),
): EncryptedAttachment {
  if (attachmentKey.length !== 32) {
    throw new Error(`encryptAttachment: key is ${attachmentKey.length} bytes, expected 32`);
  }
  if (attachmentId.length !== 16) {
    throw new Error(
      `encryptAttachment: attachment id is ${attachmentId.length} bytes, expected 16`,
    );
  }
  const nonce = randomBytes(12);
  const ciphertext = aes256GcmEncrypt(attachmentKey, nonce, plaintext, aadFor(attachmentId));
  return { attachmentId, nonce, ciphertext, cipherHash: blake2b256(ciphertext) };
}

/** Decrypt a reassembled ciphertext. Throws on any authentication failure. */
export function decryptAttachment(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  attachmentKey: Uint8Array,
  attachmentId: Uint8Array,
): Uint8Array {
  if (nonce.length !== 12) {
    throw new Error(`decryptAttachment: nonce is ${nonce.length} bytes, expected 12`);
  }
  return aes256GcmDecrypt(attachmentKey, nonce, ciphertext, aadFor(attachmentId));
}

/** Positional fixed-size split; the final chunk carries the remainder. */
export function splitIntoChunks(
  data: Uint8Array,
  chunkBytes: number = ATTACHMENT_CHUNK_BYTES,
): Uint8Array[] {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error(`splitIntoChunks: invalid chunk size ${String(chunkBytes)}`);
  }
  if (data.length === 0) {
    throw new Error("splitIntoChunks: refusing to chunk empty data");
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkBytes) {
    chunks.push(data.slice(offset, Math.min(data.length, offset + chunkBytes)));
  }
  return chunks;
}

/** Positional reassembly — inverse of {@link splitIntoChunks}. */
export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** blake2b-256 (CKB-compatible — content addressing, spec §9.3 hashes). */
export function blake2b256(data: Uint8Array): Uint8Array {
  return ckbHash(data);
}
