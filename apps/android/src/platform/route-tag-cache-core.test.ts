import { describe, expect, it } from "vitest";
import {
  ROUTE_TAG_BLOB_KEY,
  RouteTagCacheCore,
  type RouteTagBlobStorage,
  type RouteTagKeyStore,
} from "./route-tag-cache-core";
import { bytesToHex } from "./hex";

/**
 * Fake keychain modelling `react-native-keychain`'s actual semantics: entries
 * live under a caller-chosen service string and `set` on an existing service
 * OVERWRITES. `entries` is exposed so tests can assert how many survive.
 */
class FakeKeychain implements RouteTagKeyStore {
  readonly entries = new Map<string, Uint8Array>();
  wraps = 0;

  constructor(private readonly service = "cemp.rt.v1") {}

  wrap(value: Uint8Array): Promise<Uint8Array> {
    this.wraps += 1;
    this.entries.set(this.service, value);
    return Promise.resolve(new TextEncoder().encode("rt1"));
  }

  unwrap(blob: Uint8Array): Promise<Uint8Array> {
    if (new TextDecoder().decode(blob) !== "rt1") {
      return Promise.reject(new Error("not a route-tag blob"));
    }
    const stored = this.entries.get(this.service);
    return stored === undefined
      ? Promise.reject(new Error("no route-tag entry"))
      : Promise.resolve(stored);
  }

  clear(): Promise<void> {
    this.entries.delete(this.service);
    return Promise.resolve();
  }
}

class FakeStorage implements RouteTagBlobStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): Promise<string | null> {
    return Promise.resolve(this.items.get(key) ?? null);
  }
  setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
    return Promise.resolve();
  }
  removeItem(key: string): Promise<void> {
    this.items.delete(key);
    return Promise.resolve();
  }
}

function makeCache(): { cache: RouteTagCacheCore; keychain: FakeKeychain; storage: FakeStorage } {
  const keychain = new FakeKeychain();
  const storage = new FakeStorage();
  return { cache: new RouteTagCacheCore(keychain, storage), keychain, storage };
}

describe("route tag cache core", () => {
  it("round-trips a cache through the keystore and blob storage", async () => {
    const { cache } = makeCache();
    await cache.write({ tags: ["aa", "bb"], lastSeen: ["x:0"] });
    expect(await cache.read()).toEqual({ tags: ["aa", "bb"], lastSeen: ["x:0"] });
  });

  it("reads as undefined when nothing was ever cached", async () => {
    const { cache } = makeCache();
    expect(await cache.read()).toBeUndefined();
  });

  /* ── I3: the read-modify-write that must PRESERVE lastSeen ──────────────── */

  it("writeTags replaces the tags but preserves lastSeen", async () => {
    const { cache } = makeCache();
    await cache.write({ tags: ["old"], lastSeen: ["seen:0", "seen:1"] });

    await cache.writeTags(["new-a", "new-b"]);

    // Positive and specific: dropping lastSeen (the regression this guards) is
    // what would make every locked tick re-notify for already-seen messages.
    expect(await cache.read()).toEqual({
      tags: ["new-a", "new-b"],
      lastSeen: ["seen:0", "seen:1"],
    });
  });

  it("writeTags starts lastSeen empty when there is no prior cache", async () => {
    const { cache } = makeCache();
    await cache.writeTags(["aa"]);
    expect(await cache.read()).toEqual({ tags: ["aa"], lastSeen: [] });
  });

  it("writeTags preserves lastSeen across repeated refreshes", async () => {
    const { cache } = makeCache();
    await cache.write({ tags: ["e1"], lastSeen: ["x:0"] });
    await cache.writeTags(["e2"]);
    await cache.writeTags(["e3"]);
    expect((await cache.read())?.lastSeen).toEqual(["x:0"]);
  });

  /* ── C2: exactly one keychain entry, however many ticks run ─────────────── */

  it("leaves exactly one keychain entry after many rewraps", async () => {
    const { cache, keychain } = makeCache();
    for (let tick = 0; tick < 25; tick++) {
      await cache.writeTags([`epoch-${String(tick)}`]);
    }
    expect(keychain.wraps).toBe(25);
    expect(keychain.entries.size).toBe(1);
    expect(await cache.read()).toEqual({ tags: ["epoch-24"], lastSeen: [] });
  });

  /* ── C1: nothing survives a wipe ─────────────────────────────────────────── */

  it("clear removes both the blob pointer and the keychain entry", async () => {
    const { cache, keychain, storage } = makeCache();
    await cache.write({ tags: ["aa", "bb"], lastSeen: ["x:0"] });
    expect(storage.items.has(ROUTE_TAG_BLOB_KEY)).toBe(true);
    expect(keychain.entries.size).toBe(1);

    await cache.clear();

    expect(storage.items.has(ROUTE_TAG_BLOB_KEY)).toBe(false);
    expect(keychain.entries.size).toBe(0);
    expect(await cache.read()).toBeUndefined();
  });

  it("leaves no route-tag material recoverable after clear", async () => {
    const { cache, keychain, storage } = makeCache();
    await cache.write({ tags: ["deadbeef"], lastSeen: ["0xfeed:3"] });
    await cache.clear();

    // Everything still reachable in either store, concatenated: neither a tag
    // nor a lastSeen outpoint may appear anywhere in it.
    const residue = [
      ...storage.items.values(),
      ...[...keychain.entries.values()].map(bytesToHex),
    ].join("|");
    expect(residue).not.toContain("deadbeef");
    expect(residue).not.toContain("feed");
    expect(residue).toBe("");
  });

  it("reads as undefined when the keychain entry is gone but the pointer remains", async () => {
    const { cache, keychain } = makeCache();
    await cache.write({ tags: ["aa"], lastSeen: [] });
    await keychain.clear(); // keystore reset out from under us
    expect(await cache.read()).toBeUndefined();
  });
});
