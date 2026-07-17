/**
 * CEMP v1 Molecule codecs (spec §13; normative schema:
 * `packages/cemp-core/schemas/cemp-v1.mol`).
 *
 * Dependency note: `@ckb-ccc/core` (pinned 1.12.5 repo-wide, ADR 0004 — the
 * 1.16.1 decoder mutates transactions) is cemp-core's only heavy dependency
 * and is used here EXCLUSIVELY for its declarative Molecule codec API
 * (`mol.table` / `mol.struct` / `mol.option` / `mol.vector` …). Do not use
 * CCC for RPC, signers or transaction building in this package.
 *
 * No hand-written offset arithmetic: every structure is declared as a CCC
 * codec and all byte packing/unpacking is done by the library. Strictness
 * (spec §12.1 — reject trailing bytes, invalid offsets, wrong fixed sizes; no
 * partial parses) is enforced by:
 *
 *  1. CCC's own size checks (fixed-size codecs verify exact byte length;
 *     tables/vectors verify the declared total against the buffer length and
 *     tables reject extra fields unless explicitly allowed), and
 *  2. a canonical re-encode equality check in every `decodeX`: the input must
 *     be byte-identical to the canonical re-encoding of the decoded value,
 *     which rejects reordered/overlapping offsets and any other non-canonical
 *     layout without parsing a single offset by hand.
 *
 * Oversized-declaration guard (spec §14: hostile "oversized declarations"
 * MUST fail safely): CCC 1.12.5 `dynItemVec` trusts the first offset entry to
 * size a JS array BEFORE comparing it with the buffer length, so a corrupted
 * dynvec header (`4 + n*4` larger than the buffer) forces a giant allocation
 * — a hang/OOM, not a clean error. Every dynamic-item vector below is wrapped
 * in `guardedDynItemVec`, which rejects impossible headers up front. The
 * guard reads header fields through CCC's own `mol.Uint32` codec — it is a
 * defensive size check, not hand-written serialization.
 *
 * CCC 1.12.5 typing quirk: its `Codec` class declares
 * `byteLength?: number | undefined`, which does not satisfy CCC's own
 * `CodecLike` constraint under this repo's `exactOptionalPropertyTypes: true`
 * (tsconfig.base.json). The {@link MolCodec} type below is `CodecLike` minus
 * the `byteLength` property, so CCC combinators accept our codecs again. The
 * runtime objects are untouched CCC codecs and keep their `byteLength` (CCC
 * needs it to pick fixvec vs dynvec and to size structs) — only the static
 * type is narrowed.
 */

import { mol } from "@ckb-ccc/core";
import type { BytesLike } from "@ckb-ccc/core";

// ── errors ──────────────────────────────────────────────────────────────────

/** All decode/encode failures of CEMP v1 wire data are reported as this type. */
export class CempCodecError extends Error {
  readonly structure: string;

  constructor(structure: string, detail: string) {
    super(`${structure}: ${detail}`);
    this.name = "CempCodecError";
    this.structure = structure;
  }
}

function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── byte helpers ────────────────────────────────────────────────────────────

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Lowercase hex without `0x`, matching the protocol document's convention (spec §1). */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Inverse of {@link bytesToHex}; rejects anything but even-length lowercase hex. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new CempCodecError("hex", `invalid lowercase hex string of length ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Normalize any CCC `BytesLike` to a plain `Uint8Array`. CCC's own
 * `bytesFrom(string)` goes through Node's `Buffer.from`, which both leaks
 * `Buffer` (not `Uint8Array`) instances into decoded values and crashes on
 * Hermes/React Native, where `Buffer` does not exist — cemp-core must stay
 * platform-neutral. Pure JS, no `Buffer` anywhere on the decode path.
 */
function toPlainBytes(data: BytesLike): Uint8Array {
  if (typeof data === "string") {
    return hexToBytes(data.startsWith("0x") ? data.slice(2) : data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return Uint8Array.from(data);
}

// ── codec construction helpers ──────────────────────────────────────────────

/**
 * A CCC codec viewed through a `byteLength`-free structural type (see the
 * file header for the `exactOptionalPropertyTypes` quirk). Structurally this
 * is CCC's `CodecLike`, so all CCC combinators accept it.
 */
export type MolCodec<Encodable, Decoded> = {
  readonly encode: (encodable: Encodable) => Uint8Array;
  readonly decode: (decodable: BytesLike, config?: { isExtraFieldIgnored?: boolean }) => Decoded;
};

/** Narrow a CCC codec to {@link MolCodec} (type-level only; see file header). */
function typed<Encodable, Decoded>(
  codec: mol.Codec<Encodable, Decoded>,
): MolCodec<Encodable, Decoded> {
  return codec;
}

/**
 * Fixed-size byte array (`array X [byte; n]`). Mirrors CCC's own predefined
 * Byte16/Byte32 but decodes to `Uint8Array` instead of a hex string. CCC's
 * `Codec.from` adds the strict exact-length check on both encode and decode.
 */
function fixedBytes(byteLength: number): MolCodec<Uint8Array, Uint8Array> {
  return typed(
    mol.Codec.from({
      byteLength,
      encode: (value: Uint8Array) => value,
      decode: (buffer: BytesLike) => toPlainBytes(buffer),
    }),
  );
}

/**
 * Reject out-of-range integers on encode. CCC's `numToBytes` throws on
 * positive overflow but silently two's-complements negative values, which
 * would corrupt the wire format without a sound; local values are trusted but
 * bugs should fail loudly. Decoding is unaffected (fixed widths always yield
 * in-range values).
 */
function guardUintRange(label: string, max: bigint) {
  return <T extends number | bigint>(value: T): T => {
    const v = typeof value === "bigint" ? value : BigInt(value);
    if ((typeof value === "number" && !Number.isInteger(value)) || v < 0n || v > max) {
      throw new Error(`${label}: integer out of range: ${String(value)}`);
    }
    return value;
  };
}

/**
 * Dynamic-item vector (`vector X <Table>`) with a hostile-header guard.
 * See the file header for why CCC 1.12.5 `dynItemVec` must not see unchecked
 * input. All actual decoding is still performed by CCC.
 */
function guardedDynItemVec<Encodable, Decoded>(
  structure: string,
  itemCodec: MolCodec<Encodable, Decoded>,
): MolCodec<Encodable[], Decoded[]> {
  const inner = mol.dynItemVec(itemCodec);
  return typed(
    mol.Codec.from({
      encode: (items: Encodable[]) => inner.encode(items),
      decode: (buffer: BytesLike, config?: { isExtraFieldIgnored?: boolean }) => {
        const value = toPlainBytes(buffer);
        if (value.byteLength < 4) {
          throw new Error(
            `${structure}: too short buffer, expected at least 4 bytes, but got ${value.byteLength}`,
          );
        }
        const declaredTotal = mol.Uint32.decode(value.subarray(0, 4));
        if (declaredTotal !== value.byteLength) {
          throw new Error(
            `${structure}: invalid buffer size, expected ${declaredTotal}, but got ${value.byteLength}`,
          );
        }
        if (declaredTotal > 4) {
          // First offset must be 4 + itemCount*4, within the buffer,
          // 4-aligned, and the offset table must fit in the declared total.
          const firstOffset = mol.Uint32.decode(value.subarray(4, 8));
          if (firstOffset < 8 || firstOffset > declaredTotal || (firstOffset - 4) % 4 !== 0) {
            throw new Error(
              `${structure}: invalid first offset ${firstOffset} for total size ${declaredTotal}`,
            );
          }
          const itemCount = (firstOffset - 4) / 4;
          if (4 + itemCount * 4 > declaredTotal) {
            throw new Error(
              `${structure}: declared ${itemCount} items overflow total size ${declaredTotal}`,
            );
          }
        }
        return inner.decode(value, config);
      },
    }),
  );
}

// ── primitives (schema: primitives) ─────────────────────────────────────────

export const Uint32Mol: MolCodec<number, number> = typed(
  mol.Uint32.mapIn(guardUintRange("Uint32", 0xff_ff_ff_ffn)),
);
export const Uint64Mol: MolCodec<bigint, bigint> = typed(
  mol.Uint64.mapIn(guardUintRange("Uint64", 0xff_ff_ff_ff_ff_ff_ff_ffn)),
);

const byteMol: MolCodec<number, number> = typed(mol.Uint8.mapIn(guardUintRange("byte", 0xffn)));

/** `vector Bytes <byte>` — length-prefixed byte string, decoded as plain Uint8Array. */
export const BytesMol: MolCodec<Uint8Array, Uint8Array> = typed(
  mol.byteVec(
    typed(
      mol.Codec.from({
        encode: (value: Uint8Array) => value,
        decode: (buffer: BytesLike) => toPlainBytes(buffer),
      }),
    ),
  ),
);
export const BytesOptMol = typed(mol.option(BytesMol));

export const Byte12Mol = fixedBytes(12);
export const Byte16Mol = fixedBytes(16);
export const Byte32Mol = fixedBytes(32);

export const Byte16OptMol = typed(mol.option(Byte16Mol));
export const Byte32OptMol = typed(mol.option(Byte32Mol));

// ── algorithm identifiers (spec §3) ─────────────────────────────────────────

export const AlgorithmIdV1Codec = typed(
  mol.struct({
    family: byteMol,
    parameter: byteMol,
  }),
);
export type AlgorithmIdV1 = mol.DecodedType<typeof AlgorithmIdV1Codec>;

// ── profile (spec §5) ───────────────────────────────────────────────────────

export const MlDsa65PublicKeyMol = fixedBytes(1952);
export const MlKem768PublicKeyMol = fixedBytes(1184);

/** `vector ProtocolVersions <byte>` — fixvec of version bytes. */
export const ProtocolVersionsMol = typed(mol.fixedItemVec(byteMol));

export const CempProfileV1Codec = typed(
  mol.table({
    protocol_version: byteMol,
    sig_algorithm: AlgorithmIdV1Codec,
    kem_algorithm: AlgorithmIdV1Codec,
    ml_dsa_public_key: MlDsa65PublicKeyMol,
    ml_kem_public_key: MlKem768PublicKeyMol,
    lock_script_hash: Byte32Mol,
    supported_protocol_versions: ProtocolVersionsMol,
    supported_attachments: byteMol,
    handle: BytesOptMol,
    icon_hash: Byte32OptMol,
    key_created_at: Uint64Mol,
    rotation_sequence: Uint32Mol,
    previous_profile_id: Byte32OptMol,
    revoked: byteMol,
  }),
);
export type CempProfileV1 = mol.DecodedType<typeof CempProfileV1Codec>;
export type CempProfileV1Encodable = mol.EncodableType<typeof CempProfileV1Codec>;

// ── envelope (spec §7) ──────────────────────────────────────────────────────

export const MlKem768CiphertextMol = fixedBytes(1088);
export const AesGcmNonceMol = fixedBytes(12);

export const CempEnvelopeHeaderV1Codec = typed(
  mol.table({
    protocol_version: byteMol,
    network: byteMol,
    content_type: byteMol,
    message_id: Byte16Mol,
    conversation_id: Byte32Mol,
    sender_profile_id: Byte32Mol,
    created_at_client: Uint64Mol,
    reply_to_message_id: Byte16OptMol,
    expiry_hint: Uint64Mol,
  }),
);
export type CempEnvelopeHeaderV1 = mol.DecodedType<typeof CempEnvelopeHeaderV1Codec>;
export type CempEnvelopeHeaderV1Encodable = mol.EncodableType<typeof CempEnvelopeHeaderV1Codec>;

export const CempEnvelopeV1Codec = typed(
  mol.table({
    header: CempEnvelopeHeaderV1Codec,
    kem_ciphertext: MlKem768CiphertextMol,
    nonce: AesGcmNonceMol,
    encrypted_payload: BytesMol,
  }),
);
export type CempEnvelopeV1 = mol.DecodedType<typeof CempEnvelopeV1Codec>;
export type CempEnvelopeV1Encodable = mol.EncodableType<typeof CempEnvelopeV1Codec>;

// ── payload (spec §8) ───────────────────────────────────────────────────────

export const OutPointV1Codec = typed(
  mol.table({
    tx_hash: Byte32Mol,
    index: Uint32Mol,
  }),
);
export type OutPointV1 = mol.DecodedType<typeof OutPointV1Codec>;
export type OutPointV1Encodable = mol.EncodableType<typeof OutPointV1Codec>;

export const OutPointOptMol = typed(mol.option(OutPointV1Codec));
export const OutPointVecMol = guardedDynItemVec("OutPointVec", OutPointV1Codec);

export const ReceiptEntryV1Codec = typed(
  mol.table({
    message_id: Byte16Mol,
    status: byteMol,
  }),
);
export type ReceiptEntryV1 = mol.DecodedType<typeof ReceiptEntryV1Codec>;
export type ReceiptEntryV1Encodable = mol.EncodableType<typeof ReceiptEntryV1Codec>;

export const ReceiptVecMol = guardedDynItemVec("ReceiptVec", ReceiptEntryV1Codec);

export const AttachmentManifestV1Codec = typed(
  mol.table({
    attachment_id: Byte16Mol,
    ckbfs_root: OutPointV1Codec,
    chunk_outpoints: OutPointVecMol,
    encrypted_size: Uint64Mol,
    plaintext_size: Uint64Mol,
    mime_type: BytesMol,
    width: Uint32Mol,
    height: Uint32Mol,
    thumbnail: BytesOptMol,
    content_hash: Byte32Mol,
    cipher_hash: Byte32Mol,
    encryption_nonce: AesGcmNonceMol,
    encryption_algorithm: AlgorithmIdV1Codec,
    reclaim_group_id: Byte16Mol,
  }),
);
export type AttachmentManifestV1 = mol.DecodedType<typeof AttachmentManifestV1Codec>;
export type AttachmentManifestV1Encodable = mol.EncodableType<typeof AttachmentManifestV1Codec>;

export const AttachmentManifestVecMol = guardedDynItemVec(
  "AttachmentManifestVec",
  AttachmentManifestV1Codec,
);

export const CempPayloadV1Codec = typed(
  mol.table({
    message_id: Byte16Mol,
    body_type: byteMol,
    recipient_profile_id: Byte32Mol,
    text: BytesOptMol,
    attachment_manifests: AttachmentManifestVecMol,
    reply_to_message_id: Byte16OptMol,
    reply_to_outpoint: OutPointOptMol,
    receipts: ReceiptVecMol,
    receipt_request: byteMol,
    client_timestamp: Uint64Mol,
    sender_device_id: Byte16Mol,
    padding: BytesMol,
  }),
);
export type CempPayloadV1 = mol.DecodedType<typeof CempPayloadV1Codec>;
export type CempPayloadV1Encodable = mol.EncodableType<typeof CempPayloadV1Codec>;

// ── reclaim journal (spec §10, local only) ──────────────────────────────────

export const ReclaimGroupV1Codec = typed(
  mol.table({
    reclaim_group_id: Byte16Mol,
    reason: byteMol,
    created_at: Uint64Mol,
    outpoints: OutPointVecMol,
  }),
);
export type ReclaimGroupV1 = mol.DecodedType<typeof ReclaimGroupV1Codec>;
export type ReclaimGroupV1Encodable = mol.EncodableType<typeof ReclaimGroupV1Codec>;

// ── strict encode/decode pairs ──────────────────────────────────────────────

/**
 * Builds the strict `encodeX`/`decodeX` pair for one schema structure.
 * `decode` rejects trailing bytes, wrong fixed sizes and non-canonical
 * layouts with {@link CempCodecError} (spec §12.1); see the file header.
 */
function strictPair<Encodable, Decoded>(
  structure: string,
  codec: MolCodec<Encodable, Decoded>,
): { encode: (value: Encodable) => Uint8Array; decode: (data: BytesLike) => Decoded } {
  return {
    encode(value: Encodable): Uint8Array {
      try {
        return codec.encode(value);
      } catch (e) {
        throw new CempCodecError(structure, `encode failed: ${errorDetail(e)}`);
      }
    },
    decode(data: BytesLike): Decoded {
      let bytes: Uint8Array;
      try {
        bytes = toPlainBytes(data);
      } catch (e) {
        throw new CempCodecError(structure, `input is not byte-like: ${errorDetail(e)}`);
      }
      let decoded: Decoded;
      try {
        decoded = codec.decode(bytes);
      } catch (e) {
        throw new CempCodecError(structure, `decode failed: ${errorDetail(e)}`);
      }
      // Canonical form check: the input must be exactly the canonical
      // re-encoding of the decoded value. This is what makes the decode
      // strict against non-canonical offset layouts (spec §12.1).
      let canonical: Uint8Array;
      try {
        canonical = codec.encode(decoded as unknown as Encodable);
      } catch (e) {
        throw new CempCodecError(structure, `canonical re-encode failed: ${errorDetail(e)}`);
      }
      if (!bytesEqual(canonical, bytes)) {
        throw new CempCodecError(
          structure,
          "non-canonical Molecule encoding (re-encode differs from input)",
        );
      }
      return decoded;
    },
  };
}

const uint32Pair = strictPair("Uint32", Uint32Mol);
export const encodeUint32 = uint32Pair.encode;
export const decodeUint32 = uint32Pair.decode;

const uint64Pair = strictPair("Uint64", Uint64Mol);
export const encodeUint64 = uint64Pair.encode;
export const decodeUint64 = uint64Pair.decode;

const bytesPair = strictPair("Bytes", BytesMol);
export const encodeBytes = bytesPair.encode;
export const decodeBytes = bytesPair.decode;

const bytesOptPair = strictPair("BytesOpt", BytesOptMol);
export const encodeBytesOpt = bytesOptPair.encode;
export const decodeBytesOpt = bytesOptPair.decode;

const byte12Pair = strictPair("Byte12", Byte12Mol);
export const encodeByte12 = byte12Pair.encode;
export const decodeByte12 = byte12Pair.decode;

const byte16Pair = strictPair("Byte16", Byte16Mol);
export const encodeByte16 = byte16Pair.encode;
export const decodeByte16 = byte16Pair.decode;

const byte32Pair = strictPair("Byte32", Byte32Mol);
export const encodeByte32 = byte32Pair.encode;
export const decodeByte32 = byte32Pair.decode;

const byte16OptPair = strictPair("Byte16Opt", Byte16OptMol);
export const encodeByte16Opt = byte16OptPair.encode;
export const decodeByte16Opt = byte16OptPair.decode;

const byte32OptPair = strictPair("Byte32Opt", Byte32OptMol);
export const encodeByte32Opt = byte32OptPair.encode;
export const decodeByte32Opt = byte32OptPair.decode;

const algorithmIdPair = strictPair("AlgorithmIdV1", AlgorithmIdV1Codec);
export const encodeAlgorithmIdV1 = algorithmIdPair.encode;
export const decodeAlgorithmIdV1 = algorithmIdPair.decode;

const mlDsa65PublicKeyPair = strictPair("MlDsa65PublicKey", MlDsa65PublicKeyMol);
export const encodeMlDsa65PublicKey = mlDsa65PublicKeyPair.encode;
export const decodeMlDsa65PublicKey = mlDsa65PublicKeyPair.decode;

const mlKem768PublicKeyPair = strictPair("MlKem768PublicKey", MlKem768PublicKeyMol);
export const encodeMlKem768PublicKey = mlKem768PublicKeyPair.encode;
export const decodeMlKem768PublicKey = mlKem768PublicKeyPair.decode;

const protocolVersionsPair = strictPair("ProtocolVersions", ProtocolVersionsMol);
export const encodeProtocolVersions = protocolVersionsPair.encode;
export const decodeProtocolVersions = protocolVersionsPair.decode;

const mlKem768CiphertextPair = strictPair("MlKem768Ciphertext", MlKem768CiphertextMol);
export const encodeMlKem768Ciphertext = mlKem768CiphertextPair.encode;
export const decodeMlKem768Ciphertext = mlKem768CiphertextPair.decode;

const aesGcmNoncePair = strictPair("AesGcmNonce", AesGcmNonceMol);
export const encodeAesGcmNonce = aesGcmNoncePair.encode;
export const decodeAesGcmNonce = aesGcmNoncePair.decode;

const profilePair = strictPair("CempProfileV1", CempProfileV1Codec);
export const encodeCempProfileV1 = profilePair.encode;
export const decodeCempProfileV1 = profilePair.decode;

const envelopeHeaderPair = strictPair("CempEnvelopeHeaderV1", CempEnvelopeHeaderV1Codec);
export const encodeCempEnvelopeHeaderV1 = envelopeHeaderPair.encode;
export const decodeCempEnvelopeHeaderV1 = envelopeHeaderPair.decode;

const envelopePair = strictPair("CempEnvelopeV1", CempEnvelopeV1Codec);
export const encodeCempEnvelopeV1 = envelopePair.encode;
export const decodeCempEnvelopeV1 = envelopePair.decode;

const outPointPair = strictPair("OutPointV1", OutPointV1Codec);
export const encodeOutPointV1 = outPointPair.encode;
export const decodeOutPointV1 = outPointPair.decode;

const outPointOptPair = strictPair("OutPointOpt", OutPointOptMol);
export const encodeOutPointOpt = outPointOptPair.encode;
export const decodeOutPointOpt = outPointOptPair.decode;

const outPointVecPair = strictPair("OutPointVec", OutPointVecMol);
export const encodeOutPointVec = outPointVecPair.encode;
export const decodeOutPointVec = outPointVecPair.decode;

const receiptEntryPair = strictPair("ReceiptEntryV1", ReceiptEntryV1Codec);
export const encodeReceiptEntryV1 = receiptEntryPair.encode;
export const decodeReceiptEntryV1 = receiptEntryPair.decode;

const receiptVecPair = strictPair("ReceiptVec", ReceiptVecMol);
export const encodeReceiptVec = receiptVecPair.encode;
export const decodeReceiptVec = receiptVecPair.decode;

const attachmentManifestPair = strictPair("AttachmentManifestV1", AttachmentManifestV1Codec);
export const encodeAttachmentManifestV1 = attachmentManifestPair.encode;
export const decodeAttachmentManifestV1 = attachmentManifestPair.decode;

const attachmentManifestVecPair = strictPair("AttachmentManifestVec", AttachmentManifestVecMol);
export const encodeAttachmentManifestVec = attachmentManifestVecPair.encode;
export const decodeAttachmentManifestVec = attachmentManifestVecPair.decode;

const payloadPair = strictPair("CempPayloadV1", CempPayloadV1Codec);
export const encodeCempPayloadV1 = payloadPair.encode;
export const decodeCempPayloadV1 = payloadPair.decode;

const reclaimGroupPair = strictPair("ReclaimGroupV1", ReclaimGroupV1Codec);
export const encodeReclaimGroupV1 = reclaimGroupPair.encode;
export const decodeReclaimGroupV1 = reclaimGroupPair.decode;
