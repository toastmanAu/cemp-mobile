/**
 * Node-only {@link VaultStorage} backed by the filesystem.
 *
 * Exported via the `./node` subpath of @cemp/secure-vault — NEVER from the
 * package root — so React Native/Hermes bundlers never resolve `node:fs`.
 * Used by desktop tooling and tests.
 *
 * Writes are atomic (write to a temp file in the same directory, fsync-free
 * rename) and files are created mode 0600. Object names are validated
 * against a strict allowlist pattern before touching the path (rule 4 —
 * even though names are internal constants today, the store must never
 * become a path-traversal primitive).
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VaultStorage } from "./storage.js";

/** Object names: dot-separated lowercase identifiers only (e.g. cemp.vault.json). */
const SAFE_NAME = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

export class FileVaultStorage implements VaultStorage {
  readonly #baseDir: string;

  constructor(baseDir: string) {
    this.#baseDir = baseDir;
  }

  async read(name: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.#path(name));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw e;
    }
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(name);
    await mkdir(this.#baseDir, { recursive: true, mode: 0o700 });
    // Same-directory temp file + rename: a crash mid-write never leaves a
    // truncated vault file behind.
    const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, path);
  }

  async delete(name: string): Promise<void> {
    try {
      await unlink(this.#path(name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw e;
    }
  }

  #path(name: string): string {
    if (!SAFE_NAME.test(name)) {
      throw new Error(`FileVaultStorage: unsafe object name rejected: ${JSON.stringify(name)}`);
    }
    return join(this.#baseDir, name);
  }
}
