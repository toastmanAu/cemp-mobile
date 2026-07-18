/**
 * Vault file format v1 (AGENTS.md rule 13 — versioned serialized object).
 *
 * A single JSON document, hex-encoded byte fields (no base64, no Buffer, so
 * the same code runs under Hermes and Node):
 *
 * ```json
 * {
 *   "version": 1,
 *   "kdf":           { "alg": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "<hex>" }
 *                    // or { "alg": "scrypt", "logN": 17, "r": 8, "p": 1, "salt": "<hex>" },
 *   "passwordSlot":  { "nonce": "<hex 12 B>", "wrappedVek": "<hex 48 B>" },
 *   "biometricSlot": { "nonce?": "<hex 12 B>", "wrappedVek": "<hex>" } | null,
 *   "payload":       { "nonce": "<hex 12 B>", "ct": "<hex>" },
 *   "meta":          { "createdAt": <epoch ms>, "wordCount": 12 | 24,
 *                      "hasPassphrase": <bool>, "autoLockSeconds": <int> }
 * }
 * ```
 *
 * Multi-slot design: the secret payload (BIP39 entropy + 64-byte seed) is
 * encrypted ONCE under a random 32-byte VEK (vault encryption key). Each wrap
 * slot stores an independent wrapping of that VEK — the password slot under a
 * KDF-derived KEK, the biometric slot as an opaque platform-keystore blob.
 * Password change re-wraps the VEK (new salt/params/nonce); the biometric
 * slot and the payload's encryption key are untouched.
 *
 * Tamper-evidence: the payload's AES-256-GCM AAD is the canonical
 * serialization of `{version, kdf, passwordSlot, biometricSlot}` (see
 * {@link payloadAad}), so any edit to the header — including the KDF salt —
 * fails payload authentication. The KDF salt is doubly protected: a changed
 * salt also derives a wrong KEK, failing the password unwrap. `meta` is
 * plaintext and NOT authenticated: it carries only non-secret UI hints, and
 * the authoritative copies of wordCount/hasPassphrase live inside the
 * encrypted payload (a tampered meta can at worst mislabel, never expose).
 *
 * Parsing treats the file as hostile input (AGENTS.md rule 4): strict shape
 * and lowercase-hex validation, unknown versions/algorithms rejected, and KDF
 * parameters capped (see kdf.ts) BEFORE any derivation.
 */

import { VaultError } from "./errors.js";
import { validateKdfParams, type KdfParams } from "./kdf.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const VAULT_FORMAT_VERSION = 1;
/**
 * Hard cap on the vault FILE size (review V4): the document is fully
 * `JSON.parse`d, so an unbounded file is an unbounded allocation from a
 * hostile local file. 64 KiB is ~40x a real v1 file.
 */
export const VAULT_FILE_MAX_BYTES = 65_536;
/** Hard cap on the biometric slot's opaque blob length (review V4). */
export const BIOMETRIC_BLOB_MAX_BYTES = 512;
/** Vault encryption key size (random, generated at creation). */
export const VEK_BYTES = 32;
/** AES-GCM wrap of the VEK: 32-byte key + 16-byte tag. */
export const VEK_WRAP_BYTES = VEK_BYTES + 16;
const AES_GCM_NONCE_BYTES = 12;

/** BIP39 word counts the vault supports (128/256-bit entropy). */
export type VaultWordCount = 12 | 24;

export interface WrapSlot {
  readonly nonce: Uint8Array;
  readonly wrappedVek: Uint8Array;
}

/**
 * Biometric slot: an opaque platform-keystore blob. `nonce` is optional —
 * keystores that embed their IV in the blob (the reference software keystore,
 * Android Keystore ciphertext) omit it; keystores that need the IV supplied
 * separately store it here.
 */
export interface BiometricWrapSlot {
  readonly nonce?: Uint8Array;
  readonly wrappedVek: Uint8Array;
}

export interface VaultFileMeta {
  /** Epoch milliseconds at creation. */
  readonly createdAt: number;
  readonly wordCount: VaultWordCount;
  /** True when the BIP39 seed was derived with a passphrase (never stored). */
  readonly hasPassphrase: boolean;
  readonly autoLockSeconds: number;
}

/** Parsed vault file (v1). All byte fields are decoded from hex. */
export interface VaultFileV1 {
  readonly version: typeof VAULT_FORMAT_VERSION;
  readonly kdf: KdfParams;
  readonly passwordSlot: WrapSlot;
  readonly biometricSlot: BiometricWrapSlot | null;
  readonly payload: { readonly nonce: Uint8Array; readonly ct: Uint8Array };
  readonly meta: VaultFileMeta;
}

/* ------------------------------------------------------------------ hex -- */

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fail(detail: string): never {
  throw new VaultError("corrupt-vault", `vault file is not a valid v1 document: ${detail}`);
}

function hexToBytes(hex: string, detail: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    fail(`${detail} must be lowercase even-length hex`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/* ------------------------------------------------- secret payload codec -- */

/**
 * The decrypted secret payload: BIP39 entropy (never the phrase — the reveal
 * flow re-derives words via `entropyToMnemonic`), the 64-byte BIP39 seed, and
 * whether a passphrase was mixed into the seed. The passphrase itself is
 * NEVER stored and cannot be recovered from the vault.
 */
export interface VaultSecretPayload {
  readonly entropy: Uint8Array;
  readonly seed: Uint8Array;
  readonly hasPassphrase: boolean;
}

const SEED_BYTES = 64;

/** Deterministic layout: entropyLen(1) ‖ entropy ‖ seed(64) ‖ flag(1). */
export function encodeSecretPayload(payload: VaultSecretPayload): Uint8Array {
  const { entropy, seed, hasPassphrase } = payload;
  if (entropy.length !== 16 && entropy.length !== 32) {
    throw new VaultError("corrupt-vault", "secret payload entropy must be 16 or 32 bytes");
  }
  if (seed.length !== SEED_BYTES) {
    throw new VaultError("corrupt-vault", `secret payload seed must be ${SEED_BYTES} bytes`);
  }
  const out = new Uint8Array(1 + entropy.length + SEED_BYTES + 1);
  out[0] = entropy.length;
  out.set(entropy, 1);
  out.set(seed, 1 + entropy.length);
  out[out.length - 1] = hasPassphrase ? 1 : 0;
  return out;
}

/** Strict inverse of {@link encodeSecretPayload}. */
export function decodeSecretPayload(bytes: Uint8Array): VaultSecretPayload {
  const entropyLen = bytes[0];
  if (entropyLen !== 16 && entropyLen !== 32) {
    fail("secret payload has an invalid entropy length");
  }
  if (bytes.length !== 1 + entropyLen + SEED_BYTES + 1) {
    fail("secret payload has an invalid total length");
  }
  const flag = bytes[bytes.length - 1];
  if (flag !== 0 && flag !== 1) {
    fail("secret payload has an invalid passphrase flag");
  }
  return {
    entropy: bytes.slice(1, 1 + entropyLen),
    seed: bytes.slice(1 + entropyLen, 1 + entropyLen + SEED_BYTES),
    hasPassphrase: flag === 1,
  };
}

/** Byte length of the plaintext payload for a word count (pre-tag). */
export function secretPayloadBytes(wordCount: VaultWordCount): number {
  return 1 + (wordCount === 12 ? 16 : 32) + SEED_BYTES + 1;
}

/* ------------------------------------------------- canonical wire form -- */

type Wire = Record<string, unknown>;

function kdfToWire(kdf: KdfParams): Wire {
  if (kdf.alg === "argon2id") {
    return { alg: kdf.alg, m: kdf.m, t: kdf.t, p: kdf.p, salt: bytesToHex(kdf.salt) };
  }
  return { alg: kdf.alg, logN: kdf.logN, r: kdf.r, p: kdf.p, salt: bytesToHex(kdf.salt) };
}

function slotToWire(slot: WrapSlot | BiometricWrapSlot): Wire {
  // exactOptionalPropertyTypes: only include `nonce` when present (biometric).
  if ("nonce" in slot && slot.nonce !== undefined) {
    return { nonce: bytesToHex(slot.nonce), wrappedVek: bytesToHex(slot.wrappedVek) };
  }
  return { wrappedVek: bytesToHex(slot.wrappedVek) };
}

/**
 * The canonical wire form of the authenticated header. Used by BOTH
 * {@link serializeVaultFile} and {@link payloadAad} so the AAD always matches
 * the header bytes other runtimes will parse. Key order is fixed by these
 * object literals (JSON.stringify preserves insertion order).
 */
function headerToWire(
  header: Pick<VaultFileV1, "version" | "kdf" | "passwordSlot" | "biometricSlot">,
): Wire {
  return {
    version: header.version,
    kdf: kdfToWire(header.kdf),
    passwordSlot: slotToWire(header.passwordSlot),
    biometricSlot: header.biometricSlot === null ? null : slotToWire(header.biometricSlot),
  };
}

/**
 * AES-GCM additional authenticated data for the payload encryption: the
 * canonical JSON of version + kdf + both wrap slots. Any header edit (salt,
 * parameters, slot bytes, version) breaks payload authentication.
 */
export function payloadAad(
  header: Pick<VaultFileV1, "version" | "kdf" | "passwordSlot" | "biometricSlot">,
): Uint8Array {
  return textEncoder.encode(JSON.stringify(headerToWire(header)));
}

/** Serialize a parsed v1 document to its UTF-8 JSON byte form. */
export function serializeVaultFile(file: VaultFileV1): Uint8Array {
  const wire = {
    ...headerToWire(file),
    payload: { nonce: bytesToHex(file.payload.nonce), ct: bytesToHex(file.payload.ct) },
    meta: {
      createdAt: file.meta.createdAt,
      wordCount: file.meta.wordCount,
      hasPassphrase: file.meta.hasPassphrase,
      autoLockSeconds: file.meta.autoLockSeconds,
    },
  };
  return textEncoder.encode(JSON.stringify(wire));
}

/* ----------------------------------------------------------------- parse -- */

function expectObject(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${detail} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectUint(value: unknown, detail: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${detail} must be an integer in [${String(min)}, ${String(max)}]`);
  }
  return value;
}

function expectBool(value: unknown, detail: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${detail} must be a boolean`);
  }
  return value;
}

function expectHexField(obj: Record<string, unknown>, field: string, detail: string): Uint8Array {
  return hexToBytes(expectObjectField(obj, field, detail) as string, `${detail}.${field}`);
}

function expectObjectField(obj: Record<string, unknown>, field: string, detail: string): unknown {
  if (!(field in obj)) {
    fail(`${detail} is missing "${field}"`);
  }
  return obj[field];
}

function parseKdf(value: unknown): KdfParams {
  const obj = expectObject(value, "kdf");
  const alg = expectObjectField(obj, "alg", "kdf");
  const salt = expectHexField(obj, "salt", "kdf");
  let params: KdfParams;
  if (alg === "argon2id") {
    params = {
      alg,
      m: expectUint(expectObjectField(obj, "m", "kdf"), "kdf.m", 1, Number.MAX_SAFE_INTEGER),
      t: expectUint(expectObjectField(obj, "t", "kdf"), "kdf.t", 1, Number.MAX_SAFE_INTEGER),
      p: expectUint(expectObjectField(obj, "p", "kdf"), "kdf.p", 1, Number.MAX_SAFE_INTEGER),
      salt,
    };
  } else if (alg === "scrypt") {
    params = {
      alg,
      logN: expectUint(expectObjectField(obj, "logN", "kdf"), "kdf.logN", 1, 63),
      r: expectUint(expectObjectField(obj, "r", "kdf"), "kdf.r", 1, Number.MAX_SAFE_INTEGER),
      p: expectUint(expectObjectField(obj, "p", "kdf"), "kdf.p", 1, Number.MAX_SAFE_INTEGER),
      salt,
    };
  } else {
    fail("kdf.alg is not a supported algorithm");
  }
  // Caps run BEFORE any caller can derive (rule 4 — hostile file DoS guard).
  validateKdfParams(params);
  return params;
}

function parsePasswordSlot(value: unknown): WrapSlot {
  const obj = expectObject(value, "passwordSlot");
  const nonce = expectHexField(obj, "nonce", "passwordSlot");
  const wrappedVek = expectHexField(obj, "wrappedVek", "passwordSlot");
  if (nonce.length !== AES_GCM_NONCE_BYTES) {
    fail("passwordSlot.nonce has an invalid length");
  }
  if (wrappedVek.length !== VEK_WRAP_BYTES) {
    fail("passwordSlot.wrappedVek has an invalid length");
  }
  return { nonce, wrappedVek };
}

function parseBiometricSlot(value: unknown): BiometricWrapSlot | null {
  if (value === null) {
    return null;
  }
  const obj = expectObject(value, "biometricSlot");
  const wrappedVek = expectHexField(obj, "wrappedVek", "biometricSlot");
  if (wrappedVek.length < 16 || wrappedVek.length > BIOMETRIC_BLOB_MAX_BYTES) {
    fail("biometricSlot.wrappedVek has an invalid length");
  }
  if ("nonce" in obj) {
    const nonce = hexToBytes(obj.nonce as string, "biometricSlot.nonce");
    if (nonce.length !== AES_GCM_NONCE_BYTES) {
      fail("biometricSlot.nonce has an invalid length");
    }
    return { nonce, wrappedVek };
  }
  return { wrappedVek };
}

/**
 * Parse and strictly validate a vault file. Throws {@link VaultError}
 * "corrupt-vault" on any shape/hex/version/algorithm violation and
 * "kdf-params-out-of-range" on excessive KDF parameters — always before any
 * key derivation runs.
 */
export function parseVaultFile(bytes: Uint8Array): VaultFileV1 {
  if (bytes.length > VAULT_FILE_MAX_BYTES) {
    fail(
      `file is ${String(bytes.length)} bytes, above the ${String(VAULT_FILE_MAX_BYTES)}-byte cap`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(textDecoder.decode(bytes));
  } catch {
    fail("not valid JSON");
  }
  const obj = expectObject(raw, "vault file");

  const version = expectUint(expectObjectField(obj, "version", "vault file"), "version", 1, 1);
  const kdf = parseKdf(expectObjectField(obj, "kdf", "vault file"));
  const passwordSlot = parsePasswordSlot(expectObjectField(obj, "passwordSlot", "vault file"));
  const biometricSlot = parseBiometricSlot(expectObjectField(obj, "biometricSlot", "vault file"));

  const payloadObj = expectObject(expectObjectField(obj, "payload", "vault file"), "payload");
  const payloadNonce = expectHexField(payloadObj, "nonce", "payload");
  const ct = expectHexField(payloadObj, "ct", "payload");
  if (payloadNonce.length !== AES_GCM_NONCE_BYTES) {
    fail("payload.nonce has an invalid length");
  }

  const metaObj = expectObject(expectObjectField(obj, "meta", "vault file"), "meta");
  const wordCountRaw = expectUint(
    expectObjectField(metaObj, "wordCount", "meta"),
    "meta.wordCount",
    12,
    24,
  );
  if (wordCountRaw !== 12 && wordCountRaw !== 24) {
    fail("meta.wordCount must be 12 or 24");
  }
  const wordCount: VaultWordCount = wordCountRaw;
  const meta: VaultFileMeta = {
    createdAt: expectUint(
      expectObjectField(metaObj, "createdAt", "meta"),
      "meta.createdAt",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    wordCount,
    hasPassphrase: expectBool(
      expectObjectField(metaObj, "hasPassphrase", "meta"),
      "meta.hasPassphrase",
    ),
    // Capped so meta can never request a timer that overflows setTimeout.
    autoLockSeconds: expectUint(
      expectObjectField(metaObj, "autoLockSeconds", "meta"),
      "meta.autoLockSeconds",
      1,
      2_147_483,
    ),
  };

  // Cross-check: the ciphertext length is determined by the word count
  // (payload codec is fixed-size), so any mismatch proves tampering.
  if (ct.length !== secretPayloadBytes(wordCount) + 16) {
    fail("payload.ct length is inconsistent with meta.wordCount");
  }

  return {
    version: version as typeof VAULT_FORMAT_VERSION,
    kdf,
    passwordSlot,
    biometricSlot,
    payload: { nonce: payloadNonce, ct },
    meta,
  };
}
