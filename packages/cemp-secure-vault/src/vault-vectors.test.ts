import { describe, expect, it } from "vitest";
import vectors from "../../cemp-test-vectors/vectors/cemp-vault-v1.json";
import { deriveLocalDatabaseKey } from "@cemp/crypto";
import { bytesToHex, parseVaultFile, serializeVaultFile } from "./format.js";
import type { KdfOptions } from "./kdf.js";
import { EphemeralSoftwareKeyStore } from "./keystore.js";
import { MemoryVaultStorage, VAULT_STORAGE_NAME } from "./storage.js";
import { SecureVaultImpl, type CreateVaultOptions } from "./vault.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/**
 * Golden vault-file vectors (Phase 3, AGENTS.md rule 13): fixedInputs make
 * creation fully deterministic. Regenerate with
 * `pnpm --filter @cemp/secure-vault exec tsx src/vectors-generate.ts`.
 */
describe("cemp-vault-v1 golden vectors", () => {
  it("has the expected suite shape", () => {
    expect(vectors.suite).toBe("cemp-vault-v1");
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const c of vectors.cases) {
    it(`parses, reproduces and unlocks case "${c.name}"`, async () => {
      const fileBytes = hexToBytes(c.vaultFileHex);

      // 1. The recorded file parses and matches the expected structure.
      const parsed = parseVaultFile(fileBytes);
      expect(parsed.version).toBe(1);
      expect(parsed.kdf.alg).toBe(c.kdf.alg);
      expect(bytesToHex(parsed.kdf.salt)).toBe(c.fixedInputs.kdfSalt);
      expect(parsed.meta).toEqual(c.expected.meta);

      // 2. Creation from the same fixed inputs reproduces the file
      //    byte-for-byte (what other runtimes conformance-test against).
      const storage = new MemoryVaultStorage();
      const vault = await SecureVaultImpl.open({
        storage,
        keystore: new EphemeralSoftwareKeyStore(),
      });
      const opts: CreateVaultOptions = {
        // The recorded KDF selection is validated by parse above; the JSON
        // import widens the discriminator to string, hence the assertion.
        kdf: c.kdf as KdfOptions,
        autoLockSeconds: c.autoLockSeconds,
        fixedInputs: {
          entropy: hexToBytes(c.fixedInputs.entropy),
          vek: hexToBytes(c.fixedInputs.vek),
          kdfSalt: hexToBytes(c.fixedInputs.kdfSalt),
          passwordSlotNonce: hexToBytes(c.fixedInputs.passwordSlotNonce),
          payloadNonce: hexToBytes(c.fixedInputs.payloadNonce),
          createdAt: c.fixedInputs.createdAt,
        },
      };
      const reveal = await vault.createWithNewMnemonic(
        c.expected.meta.wordCount as 12 | 24,
        c.password,
        opts,
      );
      expect(reveal.words.join(" ")).toBe(c.expected.mnemonic);
      const rebuilt = await storage.read(VAULT_STORAGE_NAME.vaultFile);
      expect(rebuilt).not.toBeNull();
      expect(bytesToHex(rebuilt!)).toBe(c.vaultFileHex);
      // Re-serializing the parsed file is a fixed point of the wire format.
      expect(bytesToHex(serializeVaultFile(parsed))).toBe(c.vaultFileHex);

      // 3. A fresh vault over the recorded file unlocks with the recorded
      //    password and yields the expected seed and database key.
      const unlockStorage = new MemoryVaultStorage();
      await unlockStorage.write(VAULT_STORAGE_NAME.vaultFile, fileBytes);
      const unlocking = await SecureVaultImpl.open({
        storage: unlockStorage,
        keystore: new EphemeralSoftwareKeyStore(),
      });
      await unlocking.unlock(c.password);
      const seedHex = await unlocking.withUnlockedSeed((seed) => bytesToHex(seed));
      expect(seedHex).toBe(c.expected.seed);
      expect(bytesToHex(await unlocking.getDatabaseKey())).toBe(c.expected.localDatabaseKey);
      expect(bytesToHex(deriveLocalDatabaseKey(hexToBytes(c.expected.seed)))).toBe(
        c.expected.localDatabaseKey,
      );
      expect((await unlocking.revealMnemonic(c.password)).words.join(" ")).toBe(
        c.expected.mnemonic,
      );
    });
  }
});
