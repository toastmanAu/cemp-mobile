/**
 * Password → KEK derivation for the vault's password wrap slot (spec §14.1:
 * "Argon2id preferred; Scrypt acceptable where implementation constraints
 * apply").
 *
 * Two algorithms are recorded in the vault file header (AGENTS.md rule 13 —
 * the algorithm and its parameters are part of the versioned format):
 *
 * - `argon2id` (RFC 9106), the default: m = 64 MiB, t = 3, p = 1. Pure-JS
 *   argon2 under Hermes is slow at desktop parameters; 64 MiB/t=3 is the
 *   RFC 9106 first recommended profile and is the target for mid-range
 *   Android. Android builds may instead create `scrypt` vaults where argon2
 *   proves too costly — the file records whichever was used, so unlock is
 *   algorithm-agnostic.
 * - `scrypt` (RFC 7914), the recorded alternative: logN = 17, r = 8, p = 1,
 *   matching the key-vault-wasm reference constraints
 *   (docs/grounding/reference-projects.md).
 *
 * A parsed vault file is hostile input (AGENTS.md rule 4):
 * {@link validateKdfParams} enforces hard caps BEFORE any derivation runs, or
 * a crafted file with absurd parameters is a memory/CPU denial-of-service.
 */

import { argon2id } from "@noble/hashes/argon2.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { VaultError } from "./errors.js";

const textEncoder = new TextEncoder();

/** KEK (key-encryption key) size wrapping the vault encryption key. */
export const KEK_BYTES = 32;
/** Salt size generated at vault creation (RFC 9106 recommends ≥ 8 bytes). */
export const KDF_SALT_BYTES = 16;

/** Argon2id parameters as recorded in the vault file (`m` in kibibytes). */
export interface Argon2idKdfParams {
  readonly alg: "argon2id";
  /** Memory cost in KiB. Default 64 MiB = 65536 (RFC 9106 §4). */
  readonly m: number;
  /** Iterations. Default 3 (RFC 9106 §4). */
  readonly t: number;
  /** Lanes. Default 1 (RFC 9106 §4 — parallelism > 1 helps little on mobile). */
  readonly p: number;
  readonly salt: Uint8Array;
}

/** Scrypt parameters as recorded in the vault file (`logN` = log2 of N). */
export interface ScryptKdfParams {
  readonly alg: "scrypt";
  /** log2 of the CPU/memory cost factor N. Default 17 (N = 131072). */
  readonly logN: number;
  /** Block size. Default 8 (RFC 7914 guidance). */
  readonly r: number;
  /** Parallelization. Default 1. */
  readonly p: number;
  readonly salt: Uint8Array;
}

export type KdfParams = Argon2idKdfParams | ScryptKdfParams;
export type KdfAlgorithm = KdfParams["alg"];

/**
 * Hard caps enforced on PARSED vault files before any derivation (rule 4).
 * Files we create always use the defaults above; the caps exist so a hostile
 * or corrupted file cannot request 64 GiB of memory or 2^40 scrypt rounds.
 */
export const KDF_PARAM_CAPS = {
  argon2id: {
    /** ≤ 1 GiB. */
    maxM: 1_048_576,
    maxT: 16,
    maxP: 8,
    /** RFC 9106: m ≥ 8·p KiB; 8 is the floor for p = 1. */
    minM: 8,
  },
  scrypt: {
    /** N ≤ 2^20 → at 128·N·r bytes, ≤ 1 GiB with r = 8. */
    maxLogN: 20,
    maxR: 8,
    maxP: 8,
    minLogN: 1,
  },
  /** RFC 9106 recommends ≥ 8-byte salts; cap at 64 to bound header size. */
  saltBytes: { min: 8, max: 64 },
} as const;

/**
 * Check parsed KDF parameters against {@link KDF_PARAM_CAPS}. Throws
 * {@link VaultError} "kdf-params-out-of-range" on any violation. Must run
 * before {@link deriveKek} whenever the parameters come from a file.
 */
export function validateKdfParams(params: KdfParams): void {
  const fail = (detail: string): never => {
    throw new VaultError("kdf-params-out-of-range", `vault KDF parameters out of range: ${detail}`);
  };
  const { salt } = params;
  if (salt.length < KDF_PARAM_CAPS.saltBytes.min || salt.length > KDF_PARAM_CAPS.saltBytes.max) {
    fail("salt length");
  }
  if (params.alg === "argon2id") {
    const caps = KDF_PARAM_CAPS.argon2id;
    if (
      !Number.isInteger(params.m) ||
      !Number.isInteger(params.t) ||
      !Number.isInteger(params.p) ||
      params.m < caps.minM ||
      params.m > caps.maxM ||
      params.t < 1 ||
      params.t > caps.maxT ||
      params.p < 1 ||
      params.p > caps.maxP ||
      params.m < 8 * params.p // RFC 9106: m ≥ 8·p
    ) {
      fail("argon2id m/t/p");
    }
  } else {
    const caps = KDF_PARAM_CAPS.scrypt;
    if (
      !Number.isInteger(params.logN) ||
      !Number.isInteger(params.r) ||
      !Number.isInteger(params.p) ||
      params.logN < caps.minLogN ||
      params.logN > caps.maxLogN ||
      params.r < 1 ||
      params.r > caps.maxR ||
      params.p < 1 ||
      params.p > caps.maxP
    ) {
      fail("scrypt logN/r/p");
    }
  }
}

/**
 * Derive the 32-byte KEK from a vault password. The password is UTF-8 encoded
 * as typed (no NFKC normalisation — documented in the README; users must
 * re-type the same byte sequence to unlock, which mobile input methods
 * produce deterministically). Assumes {@link validateKdfParams} already ran.
 */
export function deriveKek(password: string, params: KdfParams): Uint8Array {
  const passwordBytes = textEncoder.encode(password);
  try {
    if (params.alg === "argon2id") {
      return argon2id(passwordBytes, params.salt, {
        m: params.m,
        t: params.t,
        p: params.p,
        dkLen: KEK_BYTES,
      });
    }
    return scrypt(passwordBytes, params.salt, {
      N: 2 ** params.logN,
      r: params.r,
      p: params.p,
      dkLen: KEK_BYTES,
    });
  } finally {
    passwordBytes.fill(0);
  }
}

/** Default argon2id profile for new vaults (RFC 9106 first recommendation). */
export function defaultKdfParams(salt: Uint8Array): Argon2idKdfParams {
  return { alg: "argon2id", m: 65_536, t: 3, p: 1, salt };
}

/**
 * KDF selection at vault creation: callers may pick the algorithm and
 * override individual cost parameters (tests use tiny parameters for speed;
 * the file records exactly what was used). Anything omitted falls back to
 * the defaults above.
 */
export type KdfOptions =
  | { readonly alg: "argon2id"; readonly m?: number; readonly t?: number; readonly p?: number }
  | { readonly alg: "scrypt"; readonly logN?: number; readonly r?: number; readonly p?: number };

/** Resolve creation-time options plus a fresh salt into full parameters. */
export function resolveKdfParams(options: KdfOptions | undefined, salt: Uint8Array): KdfParams {
  if (options?.alg === "scrypt") {
    const params: ScryptKdfParams = {
      alg: "scrypt",
      logN: options.logN ?? 17,
      r: options.r ?? 8,
      p: options.p ?? 1,
      salt,
    };
    return params;
  }
  const params: Argon2idKdfParams = {
    alg: "argon2id",
    m: options?.m ?? 65_536,
    t: options?.t ?? 3,
    p: options?.p ?? 1,
    salt,
  };
  return params;
}

/* ── KDF engine seam (AGENTS.md rule 14) ─────────────────────────────────── */

/**
 * Password-KDF engine boundary. Pure-JS memory-hard KDFs (noble argon2/scrypt)
 * are catastrophically slow under Hermes — measured on a Galaxy A53
 * (2026-07-18): argon2id m=19 MiB/t=2 exceeds FOUR MINUTES. The Android
 * NativeKdfEngine (apps/android) computes the SAME algorithms in native code
 * (Bouncy Castle) at RFC 9106 strength in ~1 s. Engines must return
 * byte-identical output to {@link deriveKek} for every supported algorithm —
 * the vault file is engine-agnostic by design (params are recorded, rule 13).
 */
export interface KdfEngine {
  readonly kind: string;
  deriveKek(password: string, params: KdfParams): Promise<Uint8Array>;
}

/** The pure-JS reference engine (noble) — default everywhere. */
export class NobleKdfEngine implements KdfEngine {
  readonly kind = "noble-js";

  deriveKek(password: string, params: KdfParams): Promise<Uint8Array> {
    return Promise.resolve(deriveKek(password, params));
  }
}
