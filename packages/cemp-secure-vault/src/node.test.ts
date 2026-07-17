import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileVaultStorage } from "./node.js";

/**
 * Node-only storage backend (./node subpath). Exercised here under vitest's
 * Node environment; React Native bundles never import this module.
 */
describe("FileVaultStorage", () => {
  let dir: string;
  let storage: FileVaultStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cemp-vault-test-"));
    storage = new FileVaultStorage(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips bytes, returns null for missing objects, deletes idempotently", async () => {
    expect(await storage.read("cemp.vault.json")).toBeNull();

    const bytes = new Uint8Array([1, 2, 3, 250]);
    await storage.write("cemp.vault.json", bytes);
    expect(await storage.read("cemp.vault.json")).toEqual(bytes);

    // Overwrite and copy-out isolation: mutating the input afterwards must
    // not change the stored object.
    const updated = new Uint8Array([9, 9]);
    await storage.write("cemp.vault.json", updated);
    updated[0] = 0;
    expect(await storage.read("cemp.vault.json")).toEqual(new Uint8Array([9, 9]));

    await storage.delete("cemp.vault.json");
    expect(await storage.read("cemp.vault.json")).toBeNull();
    await storage.delete("cemp.vault.json"); // deleting a missing object succeeds
  });

  it("writes files mode 0600 and leaves no temp files behind", async () => {
    await storage.write("cemp.dbkey", new Uint8Array(16).fill(7));
    const fileStat = await stat(join(dir, "cemp.dbkey"));
    // Group/other must have no access (exact mode may be narrowed by umask).
    expect(fileStat.mode & 0o077).toBe(0);
    const entries = await readdir(dir);
    expect(entries).toEqual(["cemp.dbkey"]); // tmp file was renamed, not left behind
  });

  it("creates the base directory recursively with private permissions", async () => {
    const nested = new FileVaultStorage(join(dir, "a", "b"));
    await nested.write("cemp.dbkey", new Uint8Array([1]));
    expect(await nested.read("cemp.dbkey")).toEqual(new Uint8Array([1]));
    const dirStat = await stat(join(dir, "a", "b"));
    expect(dirStat.mode & 0o077).toBe(0);
  });

  it("rejects path-traversal object names (rule 4)", async () => {
    await expect(storage.read("../escape")).rejects.toThrow();
    await expect(storage.write("/etc/passwd", new Uint8Array([1]))).rejects.toThrow();
    await expect(storage.delete("a/b")).rejects.toThrow();
    await expect(storage.write("UPPER CASE", new Uint8Array([1]))).rejects.toThrow();
  });
});
