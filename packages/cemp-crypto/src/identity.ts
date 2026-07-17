/**
 * Identity key derivation (spec §4, §5.1):
 *
 *   bip39_seed (64 B)
 *     ├─ HKDF(info "CEMP/CKB/ML-DSA/identity/v1")          → 32 B identity sub-seed
 *     │    → deterministic FIPS-204 ML-DSA-65 keygen
 *     ├─ HKDF(info "CEMP/CKB/ML-KEM/messaging/v1")         → 32 B messaging sub-seed
 *     │    → HKDF(salt nil, info "CEMP/CKB/ML-KEM/messaging/v1/keygen", 64)
 *     │    → 64 B FIPS-203 keygen seed (d‖z) → deterministic ML-KEM-768 keygen
 *     └─ HKDF(info "CEMP/LOCAL/database/v1")               → 32 B local database key
 *
 * Profile key rotation (spec §5.3, protocol §5): rotation N ≥ 1 advances each
 * sub-seed once — HKDF(baseSubSeed, salt nil, info = rotationDomain ‖
 * u32le(N)) — and the rotated sub-seeds feed the same deterministic keygen.
 * Rotation 0 is byte-for-byte {@link deriveIdentityKeys}. The local database
 * key never rotates (local material, not messaging identity).
 *
 * The ML-DSA and ML-KEM sub-seeds are independent (spec §5.2). All domain
 * strings live in `domains.ts` and are part of the protocol (AGENTS.md
 * rule 13): changing one changes every derived key.
 *
 * Vault boundary: the returned bundle is plain byte arrays so a vault
 * (packages/cemp-secure-vault) can copy the secret material into protected
 * storage and then wipe the JS-side copy with {@link wipeIdentityKeyBundle}.
 *
 * Zeroisation status (hardening is a later phase — acknowledged, not solved):
 * - The intermediate sub-seeds and the ML-KEM keygen seed are allocated here
 *   and wiped in a `finally` block after keygen.
 * - noble's ml_kem768.keygen copies the seed into the secret-key layout and
 *   wipes its own temporaries via `cleanBytes`; what the JS engine retains
 *   (stale typed-array backing stores, GC copies) cannot be guaranteed wiped
 *   from JavaScript.
 * - The caller-owned `bip39Seed` is NOT wiped here (ownership stays with the
 *   caller, typically the vault).
 * - The returned `secretKey` buffers and `localDatabaseKey` are live secret
 *   material by design; wipe them with {@link wipeIdentityKeyBundle} once the
 *   vault has taken over.
 */

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { BIP39_SEED_BYTES } from "./bip39.js";
import { KDF_DOMAIN } from "./domains.js";
import { CempCryptoError } from "./errors.js";
import { deriveSubSeed, hkdfSha256 } from "./hkdf.js";
import { mldsaV2KeygenFromSeed } from "./mldsa-v2.js";

/** Byte sizes of ML-KEM-768 objects (FIPS 203 Table 3). */
export const ML_KEM_768_SIZES = {
  publicKey: 1184,
  secretKey: 2400,
  ciphertext: 1088,
  sharedSecret: 32,
  /** FIPS 203 deterministic keygen input (d‖z). */
  keygenSeed: 64,
} as const;

/** Byte size of the derived local-database key (spec §3: `CEMP/LOCAL/database/v1`). */
export const LOCAL_DATABASE_KEY_BYTES = 32;

export interface MlDsa65KeyPair {
  /** 1952 bytes (FIPS 204). */
  readonly publicKey: Uint8Array;
  /** 4032 bytes (FIPS 204) — secret. */
  readonly secretKey: Uint8Array;
}

export interface MlKem768KeyPair {
  /** 1184 bytes (FIPS 203). */
  readonly publicKey: Uint8Array;
  /** 2400 bytes (FIPS 203) — secret. */
  readonly secretKey: Uint8Array;
}

/**
 * Full key material derived from one BIP39 seed (spec §4). Secret fields are
 * plain bytes so they can cross the vault boundary; see the module header for
 * the zeroisation contract.
 */
export interface IdentityKeyBundle {
  /** Signing identity (locks profile and message cells). */
  readonly mlDsa: MlDsa65KeyPair;
  /** Messaging encryption identity (published in the profile cell, spec §5). */
  readonly mlKem: MlKem768KeyPair;
  /** 32-byte key for the encrypted local database (vault use, spec §11 of ckd.txt). */
  readonly localDatabaseKey: Uint8Array;
}

/**
 * Derive the complete identity key bundle from a 64-byte BIP39 seed.
 * Deterministic: the same seed always yields the same bundle (spec §4 —
 * deterministic FIPS-203/204 keygen from domain-separated sub-seeds).
 */
export function deriveIdentityKeys(bip39Seed: Uint8Array): IdentityKeyBundle {
  if (bip39Seed.length !== BIP39_SEED_BYTES) {
    throw new CempCryptoError(
      `deriveIdentityKeys: bip39Seed length ${bip39Seed.length} != ${BIP39_SEED_BYTES}`,
    );
  }
  const mlDsaSubSeed = deriveSubSeed(bip39Seed, KDF_DOMAIN.IdentityMlDsa);
  const mlKemSubSeed = deriveSubSeed(bip39Seed, KDF_DOMAIN.MessagingMlKem);
  return keygenFromSubSeeds(mlDsaSubSeed, mlKemSubSeed, deriveLocalDatabaseKey(bip39Seed));
}

/**
 * Rotation-N identity keys (spec §5.3 key-rotation chain, protocol §5):
 * each base sub-seed is advanced as
 * `HKDF(baseSubSeed, salt nil, info = rotationDomain ‖ u32le(N))` and the
 * rotated sub-seeds feed the same deterministic keygen. `rotation === 0` is
 * byte-for-byte identical to {@link deriveIdentityKeys} (backward compat).
 * The local database key is NOT rotated — it is local material, not
 * messaging identity.
 */
export function deriveRotatedIdentityKeys(
  bip39Seed: Uint8Array,
  rotation: number,
): IdentityKeyBundle {
  if (rotation === 0) {
    return deriveIdentityKeys(bip39Seed);
  }
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 0xff_ff_ff_ff) {
    throw new CempCryptoError(
      `deriveRotatedIdentityKeys: rotation ${String(rotation)} is not a uint32`,
    );
  }
  if (bip39Seed.length !== BIP39_SEED_BYTES) {
    throw new CempCryptoError(
      `deriveRotatedIdentityKeys: bip39Seed length ${bip39Seed.length} != ${BIP39_SEED_BYTES}`,
    );
  }
  const suffix = new Uint8Array(4);
  new DataView(suffix.buffer).setUint32(0, rotation, true);
  const encoder = new TextEncoder();
  const mlDsaBase = deriveSubSeed(bip39Seed, KDF_DOMAIN.IdentityMlDsa);
  const mlKemBase = deriveSubSeed(bip39Seed, KDF_DOMAIN.MessagingMlKem);
  let mlDsaSubSeed: Uint8Array | null = null;
  let mlKemSubSeed: Uint8Array | null = null;
  try {
    mlDsaSubSeed = hkdfSha256(
      mlDsaBase,
      undefined,
      concatBytes(encoder.encode(KDF_DOMAIN.RotationMlDsa), suffix),
      32,
    );
    mlKemSubSeed = hkdfSha256(
      mlKemBase,
      undefined,
      concatBytes(encoder.encode(KDF_DOMAIN.RotationMlKem), suffix),
      32,
    );
    return keygenFromSubSeeds(mlDsaSubSeed, mlKemSubSeed, deriveLocalDatabaseKey(bip39Seed));
  } finally {
    // Rotated copies are wiped inside keygenFromSubSeeds; the BASE sub-seeds
    // are this function's intermediates (deriveIdentityKeys owns its own).
    mlDsaBase.fill(0);
    mlKemBase.fill(0);
    mlDsaSubSeed?.fill(0);
    mlKemSubSeed?.fill(0);
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Deterministic keygen from a pair of sub-seeds plus the (un-rotated) local
 * database key. Wipes the sub-seed inputs before returning.
 */
function keygenFromSubSeeds(
  mlDsaSubSeed: Uint8Array,
  mlKemSubSeed: Uint8Array,
  localDatabaseKey: Uint8Array,
): IdentityKeyBundle {
  let mlKemKeygenSeed: Uint8Array | null = null;
  try {
    const mlDsa = mldsaV2KeygenFromSeed(mlDsaSubSeed);
    // FIPS-203 deterministic keygen takes a 64-byte (d‖z) seed: expand the
    // 32-byte messaging sub-seed under its own domain (spec §4).
    mlKemKeygenSeed = hkdfSha256(
      mlKemSubSeed,
      undefined,
      KDF_DOMAIN.MlKemKeygen,
      ML_KEM_768_SIZES.keygenSeed,
    );
    const { publicKey, secretKey } = ml_kem768.keygen(mlKemKeygenSeed);
    return {
      mlDsa,
      mlKem: { publicKey, secretKey },
      localDatabaseKey,
    };
  } finally {
    // Best-effort wipe of intermediates (see module header for the limits).
    mlDsaSubSeed.fill(0);
    mlKemSubSeed.fill(0);
    mlKemKeygenSeed?.fill(0);
  }
}

/**
 * The 32-byte local-database key, derived standalone (spec §3 domain
 * `CEMP/LOCAL/database/v1`). Vault unlock uses this path so it does not pay
 * for post-quantum keygen on every app start. Caller owns (and wipes) the
 * returned key.
 */
export function deriveLocalDatabaseKey(bip39Seed: Uint8Array): Uint8Array {
  if (bip39Seed.length !== BIP39_SEED_BYTES) {
    throw new CempCryptoError(
      `deriveLocalDatabaseKey: bip39Seed length ${bip39Seed.length} != ${BIP39_SEED_BYTES}`,
    );
  }
  return deriveSubSeed(bip39Seed, KDF_DOMAIN.LocalDatabase, LOCAL_DATABASE_KEY_BYTES);
}

/**
 * Best-effort wipe of all secret material in a bundle after the vault has
 * copied it into protected storage. Public keys are left intact. Subject to
 * the JavaScript zeroisation limits documented in the module header.
 */
export function wipeIdentityKeyBundle(bundle: IdentityKeyBundle): void {
  bundle.mlDsa.secretKey.fill(0);
  bundle.mlKem.secretKey.fill(0);
  bundle.localDatabaseKey.fill(0);
}
