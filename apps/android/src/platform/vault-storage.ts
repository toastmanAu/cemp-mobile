/**
 * {@link VaultStorage} over AsyncStorage (React Native).
 *
 * The vault stores exactly two small byte objects (`cemp.vault.json` — which
 * is already a JSON text document — and `cemp.dbkey`). AsyncStorage is
 * string-valued, so bytes are hex-encoded. Both objects live in the app's
 * private sandbox (unreadable to other apps); the vault file is itself
 * encrypted, so AsyncStorage plaintext-at-rest is not a secret exposure —
 * the same guarantee the Android Keystore gives `cemp.dbkey`.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { VaultStorage } from "@cemp/secure-vault";

const KEY_PREFIX = "@cemp/vault/";

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

export class AsyncStorageVaultStorage implements VaultStorage {
  async read(name: string): Promise<Uint8Array | null> {
    const value = await AsyncStorage.getItem(`${KEY_PREFIX}${name}`);
    return value === null ? null : hexToBytes(value);
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    await AsyncStorage.setItem(`${KEY_PREFIX}${name}`, bytesToHex(bytes));
  }

  async delete(name: string): Promise<void> {
    await AsyncStorage.removeItem(`${KEY_PREFIX}${name}`);
  }
}
