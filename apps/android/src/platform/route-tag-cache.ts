/**
 * Keystore-wrapped route-tag cache (Phase 9 design D2).
 *
 * Holds ONLY derived route tags — never the profile id, which would let a
 * reader derive every epoch's tag. Wrapped without the biometric flag so the
 * background probe can read it while the vault is locked; the value is a
 * privacy hint, not key material.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PlatformKeyStore } from "@cemp/secure-vault";
import { decodeTagCache, encodeTagCache, type TagCache } from "./route-tag-cache-codec";

const BLOB_KEY = "@cemp/route-tags/blob";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export class RouteTagCache {
  readonly #keystore: PlatformKeyStore;

  constructor(keystore: PlatformKeyStore) {
    this.#keystore = keystore;
  }

  async read(): Promise<TagCache | undefined> {
    const stored = await AsyncStorage.getItem(BLOB_KEY);
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
    await AsyncStorage.setItem(BLOB_KEY, bytesToHex(blob));
  }

  /**
   * Replace the tags while preserving `lastSeen`. Both refresh sites (unlock
   * and the unlocked tick) need exactly this, so it lives here rather than
   * being duplicated at each call site.
   */
  async writeTags(tags: readonly string[]): Promise<void> {
    const existing = await this.read();
    await this.write({ tags, lastSeen: existing?.lastSeen ?? [] });
  }
}
