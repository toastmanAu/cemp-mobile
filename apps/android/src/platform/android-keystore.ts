/**
 * Android {@link PlatformKeyStore} over `react-native-keychain` (AGENTS.md
 * rule 14 — the platform-neutral interface lives in @cemp/secure-vault).
 *
 * Mapping:
 * - `wrap(key)` → `setGenericPassword` of the hex key under a random service
 *   id (see keychain-blob.ts); the returned blob is the service id.
 * - `wrap(key, { biometric: true })` additionally sets
 *   `accessControl: BIOMETRY_TYPE.ANY` + an authentication prompt, so every
 *   `unwrap` triggers the Android biometric prompt
 *   (`setUserAuthenticationRequired(true)` equivalent).
 * - Secrets use `Accessible.WHEN_UNLOCKED_THIS_DEVICE_ONLY` — they never
 *   migrate off the device (reinstall without the mnemonic cannot recover,
 *   Phase 3 exit criterion).
 * - `deleteKey()` resets the default service. Orphaned random-service entries
 *   from prior wraps are unreadable without their blob and are wiped by
 *   Android on uninstall; documented in the README.
 */

import {
  ACCESS_CONTROL,
  ACCESSIBLE,
  getGenericPassword,
  resetGenericPassword,
  setGenericPassword,
  type SetOptions,
} from "react-native-keychain";
import { randomBytes } from "@cemp/crypto";
import type { PlatformKeyStore } from "@cemp/secure-vault";
import { keychainBlobFromServiceId, serviceIdFromKeychainBlob } from "./keychain-blob";

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

const BIOMETRIC_PROMPT = {
  title: "CellSend",
  subtitle: "Unlock with biometrics",
} as const;

export class AndroidKeychainKeyStore implements PlatformKeyStore {
  readonly kind = "android-keystore";

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  isBiometricAvailable(): Promise<boolean> {
    // react-native-keychain resolves biometry availability lazily; Android
    // reports enrolled biometrics through canImplyAuthentication in newer
    // versions. Bootstrap: attempt is deferred to the first biometric wrap,
    // which rejects cleanly if no hardware/enrollment exists.
    return Promise.resolve(true);
  }

  async wrap(key: Uint8Array, opts: { biometric?: boolean } = {}): Promise<Uint8Array> {
    const serviceId = bytesToHex(randomBytes(8));
    const options: SetOptions = {
      service: `cemp.ks.${serviceId}`,
      accessible: ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      ...(opts.biometric === true
        ? { accessControl: ACCESS_CONTROL.BIOMETRY_ANY, authenticationPrompt: BIOMETRIC_PROMPT }
        : {}),
    };
    const result = await setGenericPassword("cemp", bytesToHex(key), options);
    if (result === false) {
      throw new Error("android keystore: setGenericPassword failed");
    }
    return keychainBlobFromServiceId(serviceId);
  }

  async unwrap(blob: Uint8Array): Promise<Uint8Array> {
    const serviceId = serviceIdFromKeychainBlob(blob);
    const result = await getGenericPassword({
      service: `cemp.ks.${serviceId}`,
      authenticationPrompt: BIOMETRIC_PROMPT,
    });
    if (result === false) {
      throw new Error("android keystore: no secret for this blob (reinstall or keystore reset)");
    }
    return hexToBytes(result.password);
  }

  async deleteKey(): Promise<void> {
    await resetGenericPassword();
  }
}
