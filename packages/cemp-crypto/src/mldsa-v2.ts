import { blake2b } from "@noble/hashes/blake2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

/**
 * ML-DSA-65 v2 signing pipeline — pure-crypto half (no CCC dependency).
 * Byte-for-byte port of the Rust implementation documented in
 * docs/grounding/mldsa-v2-signing-pipeline.md and vendored in
 * tools/signing-harness. The transaction-stream half lives in
 * @cemp/ckb (src/cighash.ts); the two halves are joined only by byte
 * arrays so both packages stay independently compilable.
 *
 * All serialized objects here are versioned by construction: the lock
 * args carry the parameter-id flag byte and the witness lock carries the
 * has-signature flag byte (AGENTS.md rule 13).
 */

/** ML-DSA-65 parameter id used by the v2 lock script. */
export const MLDSA65_PARAM_ID = 61;

/** Byte lengths of the v2 pipeline objects (FIPS 204 §4 Table 1 + lock layout). */
export const MLDSA_V2_SIZES = {
  pk: 1952,
  sig: 3309,
  sk: 4032,
  lockArgs: 37,
  witnessLock: 5262,
} as const;

/** blake2b-256 personalisation for the pubkey hash inside lock args. */
export const MLDSA_V2_SCT_PERSONAL = "ckb-mldsa-sct";
/** blake2b-256 personalisation for the CighashAll stream digest. */
export const MLDSA_V2_MSG_PERSONAL = "ckb-mldsa-msg";
/** FIPS-204 pure-mode context baked into the final message M'. */
export const MLDSA_V2_DOMAIN = "CKB-MLDSA-LOCK";

/** Multisig header for single-sig v2 lock args: marker, require_first_n, threshold, count. */
const LOCK_ARGS_HEADER = [0x80, 0x01, 0x01, 0x01] as const;

/**
 * BLAKE2b personalisation padded to the 16-byte parameter-block field.
 * The Rust side (ckb_hash Blake2bBuilder::personal) accepts the 13-byte
 * strings and zero-pads them into the same field; @noble/hashes v2 requires
 * the full 16 bytes. Identical padding → identical parameter block.
 */
function personal16(personal: string): Uint8Array {
  const bytes = utf8ToBytes(personal);
  if (bytes.length > 16) {
    throw new Error(`personalisation "${personal}" exceeds 16 bytes`);
  }
  const out = new Uint8Array(16);
  out.set(bytes);
  return out;
}

const SCT_PERSONAL_BYTES = personal16(MLDSA_V2_SCT_PERSONAL);
const MSG_PERSONAL_BYTES = personal16(MLDSA_V2_MSG_PERSONAL);
const DOMAIN_BYTES = utf8ToBytes(MLDSA_V2_DOMAIN);
/** Empty FIPS-204 context for sign/verify — the context is baked into M'. */
const EMPTY_CONTEXT = new Uint8Array(0);

/**
 * Lock-script flag byte: (param_id << 1) | has_signature.
 * ML-DSA-65 → 0x7A in lock args (no signature), 0x7B in the witness lock.
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Parameter / flag bytes.
 */
export function constructFlag(paramId: number, hasSignature: boolean): number {
  return (paramId << 1) | (hasSignature ? 1 : 0);
}

/**
 * 37-byte v2 lock args for a public key:
 * [0x80, 0x01, 0x01, 0x01, flag(61, false), blake2b_256(pubkey, personal "ckb-mldsa-sct")].
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Lock args.
 */
export function mldsaV2LockArgs(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length !== MLDSA_V2_SIZES.pk) {
    throw new Error(`mldsaV2LockArgs: pubkey length ${pubkey.length} != ${MLDSA_V2_SIZES.pk}`);
  }
  const pkHash = blake2b(pubkey, { dkLen: 32, personalization: SCT_PERSONAL_BYTES });
  const out = new Uint8Array(MLDSA_V2_SIZES.lockArgs);
  out.set(LOCK_ARGS_HEADER, 0);
  out[4] = constructFlag(MLDSA65_PARAM_ID, false);
  out.set(pkHash, 5);
  return out;
}

/**
 * blake2b-256 digest of the CighashAll stream, personalisation "ckb-mldsa-msg".
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Digest and FIPS-204 message framing.
 */
export function cighashV2Digest(stream: Uint8Array): Uint8Array {
  return blake2b(stream, { dkLen: 32, personalization: MSG_PERSONAL_BYTES });
}

/**
 * FIPS-204 pure-mode final message M' = 0x00 || 0x0E || "CKB-MLDSA-LOCK" || digest.
 * The 0x0E is the byte length of the domain context (14).
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Digest and FIPS-204 message framing.
 */
export function buildFinalMessage(digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) {
    throw new Error(`buildFinalMessage: digest length ${digest.length} != 32`);
  }
  const out = new Uint8Array(2 + DOMAIN_BYTES.length + digest.length);
  out[0] = 0x00;
  out[1] = DOMAIN_BYTES.length;
  out.set(DOMAIN_BYTES, 2);
  out.set(digest, 2 + DOMAIN_BYTES.length);
  return out;
}

/**
 * Deterministic FIPS-204 keygen from a 32-byte seed. Must yield the same
 * keypair as the Rust fips204 crate's keygen_from_seed — enforced by the
 * golden vectors in packages/cemp-test-vectors/vectors/mldsa-v2.json.
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Key derivation.
 */
export function mldsaV2KeygenFromSeed(seed: Uint8Array): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  if (seed.length !== 32) {
    throw new Error(`mldsaV2KeygenFromSeed: seed length ${seed.length} != 32`);
  }
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  return { publicKey, secretKey };
}

/**
 * Sign a final message (M' built by buildFinalMessage) with an EMPTY ctx —
 * the context is already baked into M'. Pass 32 zero bytes as `random` to
 * reproduce the Rust harness's deterministic try_sign_with_seed(rnd = 0x00*32)
 * signatures; omit it for hedged signing (different bytes, still verifies).
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Digest and FIPS-204 message framing.
 */
export function mldsaV2Sign(
  secretKey: Uint8Array,
  finalMessage: Uint8Array,
  random?: Uint8Array,
): Uint8Array {
  if (secretKey.length !== MLDSA_V2_SIZES.sk) {
    throw new Error(`mldsaV2Sign: secretKey length ${secretKey.length} != ${MLDSA_V2_SIZES.sk}`);
  }
  if (random !== undefined && random.length !== 32) {
    throw new Error(`mldsaV2Sign: random length ${random.length} != 32`);
  }
  return ml_dsa65.sign(finalMessage, secretKey, {
    context: EMPTY_CONTEXT,
    ...(random !== undefined ? { extraEntropy: random } : {}),
  });
}

/**
 * Verify an ML-DSA-65 signature against a final message with EMPTY ctx
 * (mirrors the on-chain lock and verifying.rs). Returns false rather than
 * throwing for well-formed-but-invalid signatures.
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Digest and FIPS-204 message framing.
 */
export function mldsaV2Verify(
  publicKey: Uint8Array,
  finalMessage: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== MLDSA_V2_SIZES.pk) {
    throw new Error(`mldsaV2Verify: publicKey length ${publicKey.length} != ${MLDSA_V2_SIZES.pk}`);
  }
  if (signature.length !== MLDSA_V2_SIZES.sig) {
    throw new Error(`mldsaV2Verify: signature length ${signature.length} != ${MLDSA_V2_SIZES.sig}`);
  }
  return ml_dsa65.verify(signature, finalMessage, publicKey, { context: EMPTY_CONTEXT });
}

/**
 * 5262-byte witness lock: [flag(61, true) = 0x7B, pubkey(1952), sig(3309)].
 * See docs/grounding/mldsa-v2-signing-pipeline.md §Digest and FIPS-204 message framing.
 */
export function mldsaV2WitnessLock(publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
  if (publicKey.length !== MLDSA_V2_SIZES.pk) {
    throw new Error(
      `mldsaV2WitnessLock: publicKey length ${publicKey.length} != ${MLDSA_V2_SIZES.pk}`,
    );
  }
  if (signature.length !== MLDSA_V2_SIZES.sig) {
    throw new Error(
      `mldsaV2WitnessLock: signature length ${signature.length} != ${MLDSA_V2_SIZES.sig}`,
    );
  }
  const out = new Uint8Array(MLDSA_V2_SIZES.witnessLock);
  out[0] = constructFlag(MLDSA65_PARAM_ID, true);
  out.set(publicKey, 1);
  out.set(signature, 1 + MLDSA_V2_SIZES.pk);
  return out;
}
