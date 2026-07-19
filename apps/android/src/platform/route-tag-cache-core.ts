/**
 * Keystore-wrapped route-tag cache — pure logic (Phase 9 design D2).
 *
 * Holds ONLY derived route tags — never the profile id, which would let a
 * reader derive every epoch's tag. Wrapped without the biometric flag so the
 * background probe can read it while the vault is locked; the value is a
 * privacy hint, not key material.
 *
 * No React Native import: `route-tag-cache.ts` is the thin pass-through that
 * binds this to AsyncStorage and the Android keychain, so the read-modify-write
 * below (which must PRESERVE `lastSeen`) is unit-tested directly.
 */

import { decodeTagCache, encodeTagCache, type TagCache } from "./route-tag-cache-codec";
import { bytesToHex, hexToBytes } from "./hex";

export const ROUTE_TAG_BLOB_KEY = "@cemp/route-tags/blob";

/**
 * The keychain seam this cache needs. Narrower than `PlatformKeyStore`: it
 * adds `clear`, because the route-tag blob is the one keystore artifact whose
 * pointer lives OUTSIDE the vault file and so is not made unreachable by
 * `vault.wipe()` — it has to be destroyed explicitly.
 */
export interface RouteTagKeyStore {
  wrap(value: Uint8Array): Promise<Uint8Array>;
  unwrap(blob: Uint8Array): Promise<Uint8Array>;
  /** Destroy the keychain entry backing this cache. */
  clear(): Promise<void>;
}

/** The key/value seam (AsyncStorage in the app, a Map in tests). */
export interface RouteTagBlobStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class RouteTagCacheCore {
  readonly #keystore: RouteTagKeyStore;
  readonly #storage: RouteTagBlobStorage;

  constructor(keystore: RouteTagKeyStore, storage: RouteTagBlobStorage) {
    this.#keystore = keystore;
    this.#storage = storage;
  }

  async read(): Promise<TagCache | undefined> {
    const stored = await this.#storage.getItem(ROUTE_TAG_BLOB_KEY);
    if (stored === null) {
      return undefined;
    }
    try {
      return decodeTagCache(await this.#keystore.unwrap(hexToBytes(stored)));
    } catch {
      // Keystore reset or a malformed blob: treat as "never cached".
      return undefined;
    }
  }

  async write(cache: TagCache): Promise<void> {
    const blob = await this.#keystore.wrap(encodeTagCache(cache));
    await this.#storage.setItem(ROUTE_TAG_BLOB_KEY, bytesToHex(blob));
  }

  /**
   * Replace the tags while preserving `lastSeen`. Both refresh sites (unlock
   * and the unlocked tick) need exactly this, so it lives here rather than
   * being duplicated at each call site.
   *
   * Dropping `lastSeen` here would make every locked tick re-notify for every
   * message already seen — see the regression test in route-tag-cache-core.test.ts.
   */
  async writeTags(tags: readonly string[]): Promise<void> {
    const existing = await this.read();
    await this.write({ tags, lastSeen: existing?.lastSeen ?? [] });
  }

  /**
   * Destroy every trace of the cache: the AsyncStorage pointer AND the
   * keychain entry it points at. Called from `AppContainer.wipe()` — without
   * it, route tags and `lastSeen` outpoints (roughly three epochs of inbox
   * linkability) survive a factory wipe fully readable, because the pointer
   * lives outside the vault file that wipe deletes.
   *
   * The blob pointer goes FIRST: if the keychain reset then fails, the cache
   * already reads as "never cached" rather than staying live.
   */
  async clear(): Promise<void> {
    await this.#storage.removeItem(ROUTE_TAG_BLOB_KEY);
    await this.#keystore.clear();
  }
}
