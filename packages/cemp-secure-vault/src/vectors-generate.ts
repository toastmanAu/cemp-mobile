/**
 * Golden-vector generator for the CEMP vault file format v1 (Phase 3,
 * AGENTS.md rule 13).
 *
 * Node-only developer script — never imported by library code. Run:
 *
 *   pnpm --filter @cemp/secure-vault exec tsx src/vectors-generate.ts
 *
 * Writes `packages/cemp-test-vectors/vectors/cemp-vault-v1.json`.
 * Fully deterministic: creation goes through the vault's `fixedInputs` seam
 * (fixed entropy/VEK/salt/nonces/createdAt) plus tiny KDF parameters, so
 * regenerating MUST produce byte-identical output — drift means the format,
 * the KDF wiring or the AEAD changed, and format version, spec and vectors
 * must move together (AGENTS.md rule 1).
 *
 * Rule 2: this script prints only counts and paths — never secrets.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveLocalDatabaseKey, mnemonicToSeed } from "@cemp/crypto";
import { bytesToHex } from "./format.js";
import type { KdfOptions } from "./kdf.js";
import { EphemeralSoftwareKeyStore } from "./keystore.js";
import { MemoryVaultStorage, VAULT_STORAGE_NAME } from "./storage.js";
import { SecureVaultImpl, type VaultFixedInputs } from "./vault.js";

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

interface VaultVectorCase {
  name: string;
  /** The vault password (test-only, not a real credential). */
  password: string;
  kdf: KdfOptions;
  autoLockSeconds: number;
  /** Deterministic creation inputs (hex), injected via the fixedInputs seam. */
  fixedInputs: {
    entropy: string;
    vek: string;
    kdfSalt: string;
    passwordSlotNonce: string;
    payloadNonce: string;
    createdAt: number;
  };
  /** The serialized vault file (cemp.vault.json), hex of the UTF-8 JSON. */
  vaultFileHex: string;
  expected: {
    /** The mnemonic the reveal flow reproduces from the stored entropy. */
    mnemonic: string;
    /** The 64-byte BIP39 seed inside the encrypted payload (hex). */
    seed: string;
    /** deriveLocalDatabaseKey(seed) (hex) — what cemp.dbkey wraps. */
    localDatabaseKey: string;
    meta: {
      createdAt: number;
      wordCount: 12 | 24;
      hasPassphrase: boolean;
      autoLockSeconds: number;
    };
  };
}

async function buildCase(options: {
  name: string;
  wordCount: 12 | 24;
  password: string;
  kdf: KdfOptions;
  autoLockSeconds: number;
  fixedInputs: Required<VaultFixedInputs>;
}): Promise<VaultVectorCase> {
  const { name, wordCount, password, kdf, autoLockSeconds, fixedInputs } = options;

  // The vault takes ownership of injected buffers (it zeroizes the entropy
  // after encoding the payload); hand every creation a fresh copy so the
  // determinism rebuild below starts from the same bytes.
  const creationInputs = (): Required<VaultFixedInputs> => ({
    entropy: fixedInputs.entropy.slice(),
    vek: fixedInputs.vek.slice(),
    kdfSalt: fixedInputs.kdfSalt.slice(),
    passwordSlotNonce: fixedInputs.passwordSlotNonce.slice(),
    payloadNonce: fixedInputs.payloadNonce.slice(),
    createdAt: fixedInputs.createdAt,
  });

  const storage = new MemoryVaultStorage();
  const vault = await SecureVaultImpl.open({
    storage,
    keystore: new EphemeralSoftwareKeyStore(),
  });
  const reveal = await vault.createWithNewMnemonic(wordCount, password, {
    kdf,
    autoLockSeconds,
    fixedInputs: creationInputs(),
  });
  const fileBytes = await storage.read(VAULT_STORAGE_NAME.vaultFile);
  if (fileBytes === null) {
    throw new Error(`case ${name}: vault file was not persisted`);
  }

  // Refuse to write vectors that do not reproduce or round-trip: rebuild from
  // the same fixed inputs (byte-identical) and unlock the recorded file.
  const rebuildStorage = new MemoryVaultStorage();
  const rebuild = await SecureVaultImpl.open({
    storage: rebuildStorage,
    keystore: new EphemeralSoftwareKeyStore(),
  });
  await rebuild.createWithNewMnemonic(wordCount, password, {
    kdf,
    autoLockSeconds,
    fixedInputs: creationInputs(),
  });
  const rebuiltBytes = await rebuildStorage.read(VAULT_STORAGE_NAME.vaultFile);
  if (rebuiltBytes === null || bytesToHex(rebuiltBytes) !== bytesToHex(fileBytes)) {
    throw new Error(`case ${name}: creation is not deterministic; refusing to write vectors`);
  }

  const unlockStorage = new MemoryVaultStorage();
  await unlockStorage.write(VAULT_STORAGE_NAME.vaultFile, fileBytes);
  const unlocking = await SecureVaultImpl.open({
    storage: unlockStorage,
    keystore: new EphemeralSoftwareKeyStore(),
  });
  await unlocking.unlock(password);
  const mnemonic = reveal.words.join(" ");
  const seed = mnemonicToSeed(mnemonic);
  const unlockedSeedHex = await unlocking.withUnlockedSeed((liveSeed) => bytesToHex(liveSeed));
  if (unlockedSeedHex !== bytesToHex(seed)) {
    throw new Error(`case ${name}: unlock round-trip failed; refusing to write vectors`);
  }
  const revealedAgain = await unlocking.revealMnemonic(password);
  if (revealedAgain.words.join(" ") !== mnemonic) {
    throw new Error(`case ${name}: reveal round-trip failed; refusing to write vectors`);
  }

  return {
    name,
    password,
    kdf,
    autoLockSeconds,
    fixedInputs: {
      entropy: bytesToHex(fixedInputs.entropy),
      vek: bytesToHex(fixedInputs.vek),
      kdfSalt: bytesToHex(fixedInputs.kdfSalt),
      passwordSlotNonce: bytesToHex(fixedInputs.passwordSlotNonce),
      payloadNonce: bytesToHex(fixedInputs.payloadNonce),
      createdAt: fixedInputs.createdAt,
    },
    vaultFileHex: bytesToHex(fileBytes),
    expected: {
      mnemonic,
      seed: bytesToHex(seed),
      localDatabaseKey: bytesToHex(deriveLocalDatabaseKey(seed)),
      meta: {
        createdAt: fixedInputs.createdAt,
        wordCount,
        hasPassphrase: false,
        autoLockSeconds,
      },
    },
  };
}

const cases: VaultVectorCase[] = [
  await buildCase({
    name: "vault-argon2id-12-word",
    wordCount: 12,
    password: "cemp-vector-password",
    kdf: { alg: "argon2id", m: 32, t: 3, p: 1 },
    autoLockSeconds: 300,
    fixedInputs: {
      entropy: fill(0x07, 16),
      vek: fill(0x22, 32),
      kdfSalt: fill(0x33, 16),
      passwordSlotNonce: fill(0x44, 12),
      payloadNonce: fill(0x55, 12),
      createdAt: 1_750_000_000_000,
    },
  }),
  await buildCase({
    name: "vault-scrypt-24-word",
    wordCount: 24,
    password: "cemp-vector-password-24",
    kdf: { alg: "scrypt", logN: 10, r: 8, p: 1 },
    autoLockSeconds: 600,
    fixedInputs: {
      entropy: fill(0x09, 32),
      vek: fill(0x23, 32),
      kdfSalt: fill(0x36, 16),
      passwordSlotNonce: fill(0x46, 12),
      payloadNonce: fill(0x57, 12),
      createdAt: 1_750_000_001_000,
    },
  }),
];

const document = {
  vectorFormatVersion: 1,
  suite: "cemp-vault-v1",
  source:
    "packages/cemp-secure-vault/src/vectors-generate.ts (fixed entropy/VEK/salt/" +
    "nonces/createdAt via the fixedInputs seam, tiny recorded KDF parameters; " +
    "@noble/hashes 2.2.0 argon2id/scrypt, @noble/ciphers 2.2.0 AES-256-GCM). " +
    "The cemp.dbkey blob is deliberately excluded: it is keystore-implementation-" +
    "specific and never deterministic across platforms.",
  cases,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../cemp-test-vectors/vectors/cemp-vault-v1.json");
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${String(cases.length)} cases to ${outPath}`);
