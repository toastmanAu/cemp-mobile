/**
 * Vault persistence boundary (AGENTS.md rule 14).
 *
 * The vault stores exactly two opaque byte objects:
 *
 * - `cemp.vault.json` — the versioned vault file (see format.ts),
 * - `cemp.dbkey`      — the keystore-wrapped database encryption key.
 *
 * React Native persistence (encrypted-app-directory files or AsyncStorage)
 * plugs in behind this interface; {@link MemoryVaultStorage} serves tests;
 * `FileVaultStorage` (Node-only, exported via the `./node` subpath so RN
 * bundlers never pull `node:fs`) serves desktop tooling.
 */

/** Well-known storage object names used by the vault. */
export const VAULT_STORAGE_NAME = {
  vaultFile: "cemp.vault.json",
  databaseKey: "cemp.dbkey",
} as const;

/** Minimal async byte-object store. Implementations must be idempotent. */
export interface VaultStorage {
  /** The stored bytes, or `null` when the object does not exist. */
  read(name: string): Promise<Uint8Array | null>;
  /** Create or overwrite the object. */
  write(name: string, bytes: Uint8Array): Promise<void>;
  /** Delete the object; deleting a missing object succeeds silently. */
  delete(name: string): Promise<void>;
}

/**
 * In-memory {@link VaultStorage} for tests. A fresh instance over no data
 * simulates a reinstall (nothing readable). Bytes are copied in and out so
 * callers cannot mutate stored state by aliasing.
 */
export class MemoryVaultStorage implements VaultStorage {
  readonly #objects = new Map<string, Uint8Array>();

  read(name: string): Promise<Uint8Array | null> {
    const bytes = this.#objects.get(name);
    return Promise.resolve(bytes === undefined ? null : bytes.slice());
  }

  write(name: string, bytes: Uint8Array): Promise<void> {
    this.#objects.set(name, bytes.slice());
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    this.#objects.delete(name);
    return Promise.resolve();
  }
}
