/**
 * Attachment manifest construction + validation (spec §9.3–9.4, Phase 10
 * tasks 9, 11).
 *
 * The manifest travels inside the message's ML-KEM-protected payload
 * (attachment_manifests ≤ 4, payload size caps already enforced by the
 * codec). The RECEIVER validates declared sizes BEFORE downloading anything
 * (task 11): a hostile manifest must not be able to declare a decompression
 * bomb (rule 4) — declared plaintext above the hard protocol maximum, or
 * chunk counts that exceed what the declared ciphertext could need, are
 * rejected up front.
 */

import { codec } from "@cemp/core";
import { ATTACHMENT_CHUNK_BYTES } from "./encrypt.js";
import { DEFAULT_IMAGE_LIMITS, type ImageLimits } from "./limits.js";

export interface BuildManifestInput {
  readonly attachmentId: Uint8Array;
  /** Chunk cell outpoints in positional order; [0] doubles as ckbfs_root. */
  readonly chunkOutpoints: readonly { txHash: string; index: number }[];
  readonly encryptedSize: number;
  readonly plaintextSize: number;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly thumbnail?: Uint8Array;
  readonly contentHash: Uint8Array;
  readonly cipherHash: Uint8Array;
  readonly encryptionNonce: Uint8Array;
  readonly reclaimGroupId: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/** Build the codec-encodable manifest (spec §9.3 field-for-field). */
export function buildAttachmentManifest(
  input: BuildManifestInput,
): codec.AttachmentManifestV1Encodable {
  if (input.chunkOutpoints.length === 0) {
    throw new Error("buildAttachmentManifest: at least one chunk outpoint is required");
  }
  const outpoints = input.chunkOutpoints.map((outpoint) => ({
    tx_hash: hexToBytes(outpoint.txHash),
    index: outpoint.index,
  }));
  return {
    attachment_id: input.attachmentId,
    ckbfs_root: outpoints[0]!,
    chunk_outpoints: outpoints,
    encrypted_size: BigInt(input.encryptedSize),
    plaintext_size: BigInt(input.plaintextSize),
    mime_type: new TextEncoder().encode(input.mimeType),
    width: input.width,
    height: input.height,
    thumbnail: input.thumbnail,
    content_hash: input.contentHash,
    cipher_hash: input.cipherHash,
    encryption_nonce: input.encryptionNonce,
    encryption_algorithm: { family: 0x03, parameter: 1 },
    reclaim_group_id: input.reclaimGroupId,
  };
}

/** Validation failure detail (receiver-facing, no secret material). */
export interface ManifestCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Pre-download validation of a DECODED manifest (spec §9.4 step 2, task 11).
 * Everything here is checkable without touching the chain.
 */
export function checkManifest(
  manifest: codec.AttachmentManifestV1,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): ManifestCheck {
  const fail = (reason: string): ManifestCheck => ({ ok: false, reason });
  if (manifest.chunk_outpoints.length === 0) {
    return fail("no chunk outpoints");
  }
  if (
    manifest.plaintext_size <= 0n ||
    manifest.plaintext_size > BigInt(limits.maxAttachmentBytes)
  ) {
    return fail(`declared plaintext size ${manifest.plaintext_size} outside the protocol limit`);
  }
  if (manifest.encrypted_size <= 0n) {
    return fail("declared encrypted size is not positive");
  }
  // The declared ciphertext must be consistent with the plaintext (GCM adds
  // exactly a 16-byte tag) and with the chunk list it claims to fill —
  // otherwise the manifest is lying and we refuse to fetch anything.
  if (manifest.encrypted_size !== manifest.plaintext_size + 16n) {
    return fail("encrypted size does not equal plaintext size + GCM tag");
  }
  const neededChunks =
    (manifest.encrypted_size + BigInt(ATTACHMENT_CHUNK_BYTES - 1)) / BigInt(ATTACHMENT_CHUNK_BYTES);
  if (BigInt(manifest.chunk_outpoints.length) !== neededChunks) {
    return fail(
      `chunk count ${manifest.chunk_outpoints.length} does not match the declared encrypted size`,
    );
  }
  if (manifest.width === 0 || manifest.height === 0) {
    return fail("declared dimensions are zero");
  }
  if (Math.max(manifest.width, manifest.height) > limits.maxLongestEdgePx) {
    return fail("declared dimensions exceed the longest-edge limit");
  }
  if (
    manifest.thumbnail !== null &&
    manifest.thumbnail !== undefined &&
    manifest.thumbnail.length > 32_768
  ) {
    return fail("thumbnail exceeds 32 KiB");
  }
  if (manifest.mime_type.length === 0 || manifest.mime_type.length > 64) {
    return fail("mime type missing or oversized");
  }
  const mime = new TextDecoder().decode(manifest.mime_type);
  if (mime !== "image/webp" && mime !== "image/jpeg" && mime !== "image/png") {
    return fail(`unsupported mime type ${mime}`);
  }
  return { ok: true };
}
