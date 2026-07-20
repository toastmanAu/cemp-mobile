import {
  deriveIdentityKeys,
  deriveLocalDatabaseKey,
  mnemonicToSeed,
  validateMnemonic,
  wipeIdentityKeyBundle,
} from "@cemp/crypto";
import { describe, expect, it, vi } from "vitest";
import { VaultError, type VaultErrorCode } from "./errors.js";
import { EphemeralSoftwareKeyStore, type PlatformKeyStore } from "./keystore.js";
import { MemoryVaultStorage, VAULT_STORAGE_NAME, type VaultStorage } from "./storage.js";
import { SecureVaultImpl, type CreateVaultOptions } from "./vault.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Tiny KDF parameters so the lifecycle battery stays fast (recorded in the file). */
const TINY_KDF: CreateVaultOptions["kdf"] = { alg: "argon2id", m: 8, t: 1, p: 1 };
const PASSWORD = "vault-test-password";
const NEW_PASSWORD = "vault-test-password-rotated";

// Official BIP39 vectors (TREZOR python-mnemonic vectors.json): 128 and 256
// zero bits of entropy respectively.
const VECTOR_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon about";
const VECTOR_WORDS = VECTOR_MNEMONIC.split(" ");
const VECTOR_MNEMONIC_24 = `${"abandon ".repeat(23)}art`;

async function expectVaultError(thunk: () => unknown, code: VaultErrorCode): Promise<void> {
  try {
    await thunk();
    expect.unreachable(`expected a VaultError with code "${code}"`);
  } catch (e) {
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).code).toBe(code);
  }
}

interface VaultFixture {
  vault: SecureVaultImpl;
  storage: VaultStorage;
  keystore: PlatformKeyStore;
}

async function makeVault(
  overrides: { storage?: VaultStorage; keystore?: PlatformKeyStore } = {},
): Promise<VaultFixture> {
  const storage = overrides.storage ?? new MemoryVaultStorage();
  const keystore = overrides.keystore ?? new EphemeralSoftwareKeyStore();
  const vault = await SecureVaultImpl.open({ storage, keystore });
  return { vault, storage, keystore };
}

/** Keystore whose biometric prompt outcome tests can flip at runtime. */
function makeBiometricKeystore(): {
  keystore: EphemeralSoftwareKeyStore;
  setAccept: (accept: boolean) => void;
} {
  let accept = true;
  const keystore = new EphemeralSoftwareKeyStore({
    biometricAvailable: true,
    onBiometricPrompt: () => Promise.resolve(accept),
  });
  return {
    keystore,
    setAccept: (next: boolean) => {
      accept = next;
    },
  };
}

describe("creation and reveal (tasks 1, 4, 9)", () => {
  it.each([12, 24] as const)(
    "create(%i) produces a valid mnemonic the reveal flow reproduces",
    async (wordCount) => {
      const { vault } = await makeVault();
      const reveal = await vault.createWithNewMnemonic(wordCount, PASSWORD, { kdf: TINY_KDF });
      expect(reveal.words).toHaveLength(wordCount);
      expect(validateMnemonic(reveal.words.join(" "))).toBe(true);
      expect(vault.state).toBe("unlocked");

      // Password-gated reveal reproduces the phrase from the stored entropy,
      // from both the unlocked and the locked state, without changing it.
      expect((await vault.revealMnemonic(PASSWORD)).words).toEqual(reveal.words);
      expect(vault.state).toBe("unlocked");
      await vault.lock();
      expect((await vault.revealMnemonic(PASSWORD)).words).toEqual(reveal.words);
      expect(vault.state).toBe("locked");

      const meta = await vault.getMetadata();
      expect(meta.wordCount).toBe(wordCount);
      expect(meta.kdfAlgorithm).toBe("argon2id");
      expect(meta.biometricEnabled).toBe(false);
      expect(meta.autoLockSeconds).toBe(300);
      expect(meta.hasPassphrase).toBe(false);
      expect(meta.createdAt).toBeGreaterThan(0);
    },
  );

  it("reveal with a wrong password fails as an authentication failure", async () => {
    const { vault } = await makeVault();
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await expectVaultError(() => vault.revealMnemonic("wrong"), "wrong-password");
  });

  it("create/import refuse to overwrite an existing vault", async () => {
    const { vault } = await makeVault();
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await expectVaultError(
      () => vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF }),
      "already-initialized",
    );
    await expectVaultError(
      () => vault.importMnemonic(VECTOR_WORDS, PASSWORD, undefined, { kdf: TINY_KDF }),
      "already-initialized",
    );
  });
});

describe("import and identity restore (tasks 2, 3)", () => {
  it("restoring the same mnemonic recreates the same identity (with and without passphrase)", async () => {
    for (const passphrase of [undefined, "TREZOR"]) {
      const { vault } = await makeVault();
      await vault.importMnemonic(VECTOR_WORDS, PASSWORD, passphrase, { kdf: TINY_KDF });
      expect((await vault.getMetadata()).hasPassphrase).toBe(passphrase !== undefined);

      const direct = deriveIdentityKeys(mnemonicToSeed(VECTOR_MNEMONIC, passphrase));
      try {
        const viaVault = await vault.withUnlockedSeed((seed) => deriveIdentityKeys(seed));
        expect(bytesToHex(viaVault.mlDsa.publicKey)).toBe(bytesToHex(direct.mlDsa.publicKey));
        expect(bytesToHex(viaVault.mlKem.publicKey)).toBe(bytesToHex(direct.mlKem.publicKey));
        expect(bytesToHex(viaVault.localDatabaseKey)).toBe(bytesToHex(direct.localDatabaseKey));

        // The persisted payload reproduces the same identity after relock.
        await vault.lock();
        await vault.unlock(PASSWORD);
        const afterRelock = await vault.withUnlockedSeed((seed) => deriveIdentityKeys(seed));
        expect(bytesToHex(afterRelock.mlDsa.publicKey)).toBe(bytesToHex(direct.mlDsa.publicKey));
      } finally {
        wipeIdentityKeyBundle(direct);
      }
    }
  });

  it("imports the 24-word vector and records wordCount 24", async () => {
    const { vault } = await makeVault();
    await vault.importMnemonic(VECTOR_MNEMONIC_24.split(" "), PASSWORD, undefined, {
      kdf: TINY_KDF,
    });
    expect((await vault.getMetadata()).wordCount).toBe(24);
    expect((await vault.revealMnemonic(PASSWORD)).words.join(" ")).toBe(VECTOR_MNEMONIC_24);
  });

  it("rejects mnemonics that fail wordlist/checksum validation", async () => {
    const { vault } = await makeVault();
    // All words in the wordlist, wrong checksum (last word replaced).
    await expectVaultError(
      () => vault.importMnemonic([...VECTOR_WORDS.slice(0, 11), "abandon"], PASSWORD),
      "invalid-mnemonic",
    );
    await expectVaultError(
      () => vault.importMnemonic(VECTOR_WORDS.slice(0, 11), PASSWORD),
      "invalid-mnemonic",
    );
    await expectVaultError(
      () => vault.importMnemonic([...VECTOR_WORDS.slice(0, 11), "xyzzy"], PASSWORD),
      "invalid-mnemonic",
    );
    expect(vault.state).toBe("uninitialized");
  });
});

describe("unlock and lock (tasks 6, 8)", () => {
  it("a wrong password surfaces as wrong-password and stays locked", async () => {
    const { vault } = await makeVault();
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await vault.lock();
    await expectVaultError(() => vault.unlock("wrong"), "wrong-password");
    expect(vault.state).toBe("locked");
  });

  it("uninitialized vaults report not-initialized", async () => {
    const { vault } = await makeVault();
    expect(vault.state).toBe("uninitialized");
    await expectVaultError(() => vault.unlock(PASSWORD), "not-initialized");
    await expectVaultError(() => vault.revealMnemonic(PASSWORD), "not-initialized");
    await expectVaultError(() => vault.withUnlockedSeed((seed) => seed.length), "not-initialized");
    await expectVaultError(() => vault.getMetadata(), "not-initialized");
  });

  it("locked-state calls report locked", async () => {
    const { vault } = await makeVault();
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await vault.lock();
    await expectVaultError(() => vault.withUnlockedSeed((seed) => seed.length), "locked");
    await expectVaultError(() => vault.getDatabaseKey(), "locked");
    await expectVaultError(() => vault.unwrapDatabaseKey(), "locked");
    await expectVaultError(() => vault.generateMnemonicQuiz(), "locked");
    await expectVaultError(
      () => vault.verifyMnemonicQuiz({ positions: [1] }, ["abandon"]),
      "locked",
    );
    await expectVaultError(() => vault.enableBiometrics(), "locked");
    await expectVaultError(() => vault.disableBiometrics(), "locked");
    // lock() itself is idempotent.
    await vault.lock();
    expect(vault.state).toBe("locked");
  });

  it("locking the app removes usable key material from ordinary application state", async () => {
    const { vault } = await makeVault();
    await vault.importMnemonic(VECTOR_WORDS, PASSWORD, undefined, { kdf: TINY_KDF });

    // Capture the BORROWED buffers (the documented anti-pattern, on purpose:
    // the test asserts they carry nothing usable after lock).
    let borrowedSeed: Uint8Array | null = null;
    await vault.withUnlockedSeed((seed) => {
      borrowedSeed = seed;
    });
    const borrowedDbKey = await vault.getDatabaseKey();
    expect(borrowedSeed!.some((b) => b !== 0)).toBe(true);
    expect(borrowedDbKey.some((b) => b !== 0)).toBe(true);

    await vault.lock();
    expect(borrowedSeed!.every((b) => b === 0)).toBe(true);
    expect(borrowedDbKey.every((b) => b === 0)).toBe(true);
  });

  it("auto-locks after inactivity and touch() postpones it (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const { vault } = await makeVault();
      await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF, autoLockSeconds: 1 });
      expect(vault.state).toBe("unlocked");

      vi.advanceTimersByTime(999);
      expect(vault.state).toBe("unlocked");
      vault.touch(); // restart the inactivity window
      vi.advanceTimersByTime(999);
      expect(vault.state).toBe("unlocked");
      vi.advanceTimersByTime(1);
      expect(vault.state).toBe("locked");

      // Unlocking restarts the timer as well.
      await vault.unlock(PASSWORD);
      expect(vault.state).toBe("unlocked");
      vi.advanceTimersByTime(1_000);
      expect(vault.state).toBe("locked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes an auto-lock deadline that stays true when the timer is suspended", async () => {
    vi.useFakeTimers();
    try {
      const { vault } = await makeVault();
      expect(vault.autoLockDeadlineMs).toBeNull(); // uninitialized: no timer armed

      await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF, autoLockSeconds: 300 });
      const deadline = vault.autoLockDeadlineMs;
      expect(deadline).toBe(Date.now() + 300_000);

      // Reading state must not extend the window the way touch() does.
      expect(vault.state).toBe("unlocked");
      expect(vault.autoLockDeadlineMs).toBe(deadline);
      vi.advanceTimersByTime(1_000);
      vault.touch();
      expect(vault.autoLockDeadlineMs).toBe((deadline as number) + 1_000);

      // Move the WALL CLOCK forward without dispatching timers — exactly what a
      // React Native runtime frozen in the background does to the vault's own
      // `setTimeout`. `state` is stale here; the deadline is not.
      const overdueBy = 7 * 60_000;
      vi.setSystemTime(Date.now() + overdueBy);
      expect(vault.state).toBe("unlocked"); // stale, and knowably so
      expect(Date.now()).toBeGreaterThan(vault.autoLockDeadlineMs as number);

      // Once timers are dispatched again the vault catches up and disarms.
      vi.advanceTimersByTime(300_000);
      expect(vault.state).toBe("locked");
      expect(vault.autoLockDeadlineMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the auto-lock deadline on an explicit lock", async () => {
    const { vault } = await makeVault();
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF, autoLockSeconds: 300 });
    expect(vault.autoLockDeadlineMs).not.toBeNull();
    await vault.lock();
    expect(vault.autoLockDeadlineMs).toBeNull();
  });
});

describe("reinstall (Phase 3 exit criterion)", () => {
  it("reinstall without the mnemonic cannot recover the wallet", async () => {
    const storage = new MemoryVaultStorage();
    const { vault } = await makeVault({ storage });
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await vault.lock();

    // Fresh storage + fresh keystore = a new install: nothing to open.
    const reinstalled = await makeVault();
    expect(reinstalled.vault.state).toBe("uninitialized");
    await expectVaultError(() => reinstalled.vault.unlock(PASSWORD), "not-initialized");

    // Same files, fresh keystore (OS-level key lost): the password still
    // opens the vault file, but the wrapped database-key blob is dead weight.
    const keyGone = await makeVault({ storage, keystore: new EphemeralSoftwareKeyStore() });
    await keyGone.vault.unlock(PASSWORD);
    await expectVaultError(() => keyGone.vault.unwrapDatabaseKey(), "keystore-error");
  });
});

describe("database key wrapping (task 5, exit criterion)", () => {
  it("getDatabaseKey() and unwrapDatabaseKey() return identical bytes", async () => {
    const { vault } = await makeVault();
    await vault.importMnemonic(VECTOR_WORDS, PASSWORD, undefined, { kdf: TINY_KDF });
    // Snapshot as hex: getDatabaseKey() returns a BORROWED buffer that
    // lock() zeroizes — comparing references across a lock would read zeros.
    const derivedHex = bytesToHex(await vault.getDatabaseKey());
    const unwrapped = await vault.unwrapDatabaseKey();
    expect(bytesToHex(unwrapped)).toBe(derivedHex);
    expect(derivedHex).toBe(bytesToHex(deriveLocalDatabaseKey(mnemonicToSeed(VECTOR_MNEMONIC))));

    // Same after a relock (the cached copy was zeroized, re-derived on demand).
    await vault.lock();
    await vault.unlock(PASSWORD);
    expect(bytesToHex(await vault.getDatabaseKey())).toBe(derivedHex);
  });

  it("the database cannot be opened without the wrapped key", async () => {
    const storage = new MemoryVaultStorage();
    const keystore = new EphemeralSoftwareKeyStore();
    const { vault } = await makeVault({ storage, keystore });
    await vault.importMnemonic(VECTOR_WORDS, PASSWORD, undefined, { kdf: TINY_KDF });

    // Only the wrapped blob is persisted — it is not the key, and only the
    // originating keystore unwraps it.
    const blob = await storage.read(VAULT_STORAGE_NAME.databaseKey);
    expect(blob).not.toBeNull();
    const derived = await vault.getDatabaseKey();
    expect(bytesToHex(blob!)).not.toBe(bytesToHex(derived));
    expect(bytesToHex(await keystore.unwrap(blob!))).toBe(bytesToHex(derived));
    await expect(new EphemeralSoftwareKeyStore().unwrap(blob!)).rejects.toThrow();
  });
});

describe("biometric unlock (task 7)", () => {
  it("enable → unlock from a fresh instance via biometrics; disable removes the slot", async () => {
    const storage = new MemoryVaultStorage();
    const { keystore } = makeBiometricKeystore();
    const { vault } = await makeVault({ storage, keystore });
    const reveal = await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });

    await expectVaultError(() => vault.unlockWithBiometrics(), "biometric-unavailable");

    await vault.enableBiometrics();
    await vault.enableBiometrics(); // idempotent
    expect((await vault.getMetadata()).biometricEnabled).toBe(true);

    // A fresh vault instance (same storage + keystore) unlocks biometrically.
    const fresh = await makeVault({ storage, keystore });
    expect(fresh.vault.state).toBe("locked");
    await fresh.vault.unlockWithBiometrics();
    expect(fresh.vault.state).toBe("unlocked");
    const seedHex = await fresh.vault.withUnlockedSeed((seed) => bytesToHex(seed));
    expect(seedHex).toBe(bytesToHex(mnemonicToSeed(reveal.words.join(" "))));

    // Disable: the slot is removed, biometric unlock is unavailable again.
    await fresh.vault.disableBiometrics();
    await fresh.vault.disableBiometrics(); // idempotent
    expect((await fresh.vault.getMetadata()).biometricEnabled).toBe(false);
    const afterDisable = await makeVault({ storage, keystore });
    await expectVaultError(
      () => afterDisable.vault.unlockWithBiometrics(),
      "biometric-unavailable",
    );
  });

  it("a rejected prompt surfaces as biometric-denied", async () => {
    const storage = new MemoryVaultStorage();
    const { keystore, setAccept } = makeBiometricKeystore();
    const { vault } = await makeVault({ storage, keystore });
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await vault.enableBiometrics();

    setAccept(false);
    const fresh = await makeVault({ storage, keystore });
    await expectVaultError(() => fresh.vault.unlockWithBiometrics(), "biometric-denied");
    expect(fresh.vault.state).toBe("locked");
  });

  it("a keystore without biometric support refuses enablement", async () => {
    const { vault } = await makeVault(); // default keystore: biometrics unavailable
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await expectVaultError(() => vault.enableBiometrics(), "biometric-unavailable");
  });

  it("a fresh keystore cannot unwrap the biometric slot (reinstall modelling)", async () => {
    const storage = new MemoryVaultStorage();
    const { keystore } = makeBiometricKeystore();
    const { vault } = await makeVault({ storage, keystore });
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await vault.enableBiometrics();

    const reinstalled = await makeVault({ storage, keystore: makeBiometricKeystore().keystore });
    await expectVaultError(() => reinstalled.vault.unlockWithBiometrics(), "biometric-denied");
  });
});

describe("password change", () => {
  it("re-wraps the VEK: old fails, new works, biometric slot survives", async () => {
    const storage = new MemoryVaultStorage();
    const { keystore } = makeBiometricKeystore();
    const { vault } = await makeVault({ storage, keystore });
    const reveal = await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    await vault.enableBiometrics();

    await expectVaultError(() => vault.changePassword("wrong", NEW_PASSWORD), "wrong-password");
    await vault.changePassword(PASSWORD, NEW_PASSWORD);

    const oldPassword = await makeVault({ storage, keystore });
    await expectVaultError(() => oldPassword.vault.unlock(PASSWORD), "wrong-password");

    const newPassword = await makeVault({ storage, keystore });
    await newPassword.vault.unlock(NEW_PASSWORD);
    expect((await newPassword.vault.revealMnemonic(NEW_PASSWORD)).words).toEqual(reveal.words);

    // The biometric slot was carried over untouched.
    const biometric = await makeVault({ storage, keystore });
    await biometric.vault.unlockWithBiometrics();
    expect(biometric.vault.state).toBe("unlocked");
  });
});

describe("mnemonic confirmation quiz (task 10)", () => {
  it("generates verifiable position quizzes and rejects wrong answers", async () => {
    const { vault } = await makeVault();
    const reveal = await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });

    const quiz = await vault.generateMnemonicQuiz(3);
    expect(quiz.positions).toHaveLength(3);
    expect(new Set(quiz.positions).size).toBe(3);
    expect([...quiz.positions].sort((a, b) => a - b)).toEqual(quiz.positions);
    for (const position of quiz.positions) {
      expect(position).toBeGreaterThanOrEqual(1);
      expect(position).toBeLessThanOrEqual(12);
    }

    const answers = quiz.positions.map((position) => reveal.words[position - 1]!);
    expect(await vault.verifyMnemonicQuiz(quiz, answers)).toBe(true);
    // Answers are normalised (trim + case) before comparison.
    expect(
      await vault.verifyMnemonicQuiz(
        quiz,
        answers.map((answer) => ` ${answer.toUpperCase()} `),
      ),
    ).toBe(true);
    expect(
      await vault.verifyMnemonicQuiz(
        quiz,
        answers.map(() => "wrongword"),
      ),
    ).toBe(false);
    expect(await vault.verifyMnemonicQuiz(quiz, answers.slice(1))).toBe(false);

    // Count is configurable and clamps to the phrase length.
    expect((await vault.generateMnemonicQuiz(1)).positions).toHaveLength(1);
    expect((await vault.generateMnemonicQuiz(99)).positions).toHaveLength(12);
  });
});

describe("wipe (task 11)", () => {
  it("deletes both storage objects and the keystore key, returning to uninitialized", async () => {
    const storage = new MemoryVaultStorage();
    const keystore = new EphemeralSoftwareKeyStore();
    const { vault } = await makeVault({ storage, keystore });
    await vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    const dbKeyBlob = await storage.read(VAULT_STORAGE_NAME.databaseKey);
    expect(dbKeyBlob).not.toBeNull();

    await vault.wipe();
    expect(vault.state).toBe("uninitialized");
    expect(await storage.read(VAULT_STORAGE_NAME.vaultFile)).toBeNull();
    expect(await storage.read(VAULT_STORAGE_NAME.databaseKey)).toBeNull();
    // The keystore key is gone: previously wrapped blobs are undecryptable.
    await expect(keystore.unwrap(dbKeyBlob!)).rejects.toThrow();
    await expectVaultError(() => vault.unlock(PASSWORD), "not-initialized");

    // A fresh install over the wiped storage starts clean.
    const fresh = await makeVault({ storage });
    await fresh.vault.createWithNewMnemonic(12, PASSWORD, { kdf: TINY_KDF });
    expect(fresh.vault.state).toBe("unlocked");
  });
});

describe("scrypt vaults (recorded alternative KDF)", () => {
  it("creates and unlocks a scrypt vault, recording the algorithm", async () => {
    const { vault } = await makeVault();
    const reveal = await vault.createWithNewMnemonic(12, PASSWORD, {
      kdf: { alg: "scrypt", logN: 10, r: 8, p: 1 },
    });
    expect((await vault.getMetadata()).kdfAlgorithm).toBe("scrypt");
    await vault.lock();
    await vault.unlock(PASSWORD);
    expect((await vault.revealMnemonic(PASSWORD)).words).toEqual(reveal.words);
  });
});

describe("secret leakage (rule 2, task 12)", () => {
  it("error messages and causes carry no mnemonic words and no seed material", async () => {
    const collected: string[] = [];
    const collect = (e: unknown): void => {
      if (e instanceof Error) {
        collected.push(e.name, e.message);
        if (e.cause !== undefined) {
          collected.push(String(e.cause));
        }
      } else {
        collected.push(String(e));
      }
    };

    const storage = new MemoryVaultStorage();
    const { vault } = await makeVault({ storage });
    await vault.importMnemonic(VECTOR_WORDS, PASSWORD, undefined, { kdf: TINY_KDF });
    await vault.lock();

    await vault.unlock("definitely-wrong").catch(collect);
    await vault.revealMnemonic("definitely-wrong").catch(collect);
    await vault.changePassword("definitely-wrong", "irrelevant").catch(collect);

    // Corrupt vault file parse/decrypt failures.
    await storage.write(
      VAULT_STORAGE_NAME.vaultFile,
      new TextEncoder().encode('{"version":9,"kdf":{}}'),
    );
    const corrupt = await makeVault({ storage });
    await corrupt.vault.unlock(PASSWORD).catch(collect);
    await corrupt.vault.getMetadata().catch(collect);

    // Checksum-invalid mnemonic import (words must not be echoed back).
    const fresh = await makeVault();
    await fresh.vault
      .importMnemonic([...VECTOR_WORDS.slice(0, 11), "abandon"], PASSWORD)
      .catch(collect);

    expect(collected.length).toBeGreaterThan(0);
    const haystack = collected.join("\n").toLowerCase();
    for (const word of new Set(VECTOR_WORDS)) {
      expect(haystack).not.toContain(word);
    }
    const seedHex = bytesToHex(mnemonicToSeed(VECTOR_MNEMONIC));
    expect(haystack).not.toContain(seedHex);
    expect(haystack).not.toContain(seedHex.slice(0, 32));
  });
});
