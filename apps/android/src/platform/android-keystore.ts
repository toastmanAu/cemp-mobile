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
 *
 * The random-service scheme above suits the VAULT, which wraps only on key
 * change. It is wrong for anything that rewraps on a schedule: each wrap would
 * strand another readable entry. {@link AndroidRouteTagKeyStore} therefore uses
 * a FIXED service for the route-tag cache — see the note on that class.
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
import { bytesToHex, hexToBytes } from "./hex";
import type { RouteTagKeyStore } from "./route-tag-cache-core";

const BIOMETRIC_PROMPT = {
  title: "CellSend",
  subtitle: "Unlock with biometrics",
} as const;

/** Fixed keychain service backing the route-tag cache (see below). */
const ROUTE_TAG_SERVICE = "cemp.rt.v1";
/** Constant pointer: the fixed service means the blob carries no information. */
const ROUTE_TAG_BLOB_MARKER = "rt1";

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

/**
 * Keychain seam for the route-tag cache (Phase 9 design D2).
 *
 * Uses a FIXED service rather than {@link AndroidKeychainKeyStore}'s random
 * one. The locked background probe rewraps this cache on essentially every
 * periodic tick; with a random service id each tick would strand another
 * keychain entry holding route tags, unbounded, and the retained blob would
 * simply be overwritten so the "orphans are unreadable without their blob"
 * argument would not save us. `setGenericPassword` on a fixed service
 * OVERWRITES in place, so exactly one entry exists no matter how many ticks
 * run — and there is no crash window in which two entries co-exist, as a
 * delete-then-rewrap scheme would have.
 *
 * The randomness costs nothing here: unlike the vault's blob (which lives
 * inside the encrypted vault file), this pointer sits beside the cache in
 * plaintext AsyncStorage, so a random service id was never hiding it. The
 * vault's own wrapping is untouched.
 */
export class AndroidRouteTagKeyStore implements RouteTagKeyStore {
  async wrap(value: Uint8Array): Promise<Uint8Array> {
    const result = await setGenericPassword("cemp", bytesToHex(value), {
      service: ROUTE_TAG_SERVICE,
      accessible: ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (result === false) {
      throw new Error("android keystore: route-tag setGenericPassword failed");
    }
    return new TextEncoder().encode(ROUTE_TAG_BLOB_MARKER);
  }

  async unwrap(blob: Uint8Array): Promise<Uint8Array> {
    if (new TextDecoder().decode(blob) !== ROUTE_TAG_BLOB_MARKER) {
      throw new Error("android keystore: not a route-tag blob");
    }
    const result = await getGenericPassword({ service: ROUTE_TAG_SERVICE });
    if (result === false) {
      throw new Error("android keystore: no route-tag cache (wiped or keystore reset)");
    }
    return hexToBytes(result.password);
  }

  async clear(): Promise<void> {
    await resetGenericPassword({ service: ROUTE_TAG_SERVICE });
  }
}
