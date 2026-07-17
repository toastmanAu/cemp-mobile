/**
 * Service-id blob codec for the Android Keystore seam (pure — unit-tested
 * without React Native).
 *
 * `react-native-keychain` stores secrets under a caller-chosen `service`
 * string and returns no ciphertext we could persist — the wrapped key never
 * leaves the OS keystore. Our {@link PlatformKeyStore} contract, however,
 * returns an opaque blob that the vault persists. The blob therefore carries
 * a RANDOM service id: wrap generates `ck1.<16 hex>`, stores the hex-encoded
 * key under that service, and returns the id as the blob. unwrap(blob) parses
 * the id back out and asks the keystore for the secret. The blob is useless
 * without the keystore entry, and the entry is undiscoverable without the
 * blob (random 64-bit namespace) — together they behave like ciphertext.
 *
 * Blob format: ASCII `ck1.<16 lowercase hex chars>`, version prefix `ck1`.
 */

const BLOB_PREFIX = "ck1.";
const SERVICE_HEX_CHARS = 16;

export function isKeychainBlob(blob: Uint8Array): boolean {
  const text = new TextDecoder().decode(blob);
  return (
    text.startsWith(BLOB_PREFIX) &&
    text.length === BLOB_PREFIX.length + SERVICE_HEX_CHARS &&
    /^[0-9a-f]+$/.test(text.slice(BLOB_PREFIX.length))
  );
}

/** Build the blob for a freshly generated random service id (hex chars). */
export function keychainBlobFromServiceId(randomHex: string): Uint8Array {
  if (randomHex.length !== SERVICE_HEX_CHARS || !/^[0-9a-f]+$/.test(randomHex)) {
    throw new Error("keychain-blob: service id must be 16 lowercase hex chars");
  }
  return new TextEncoder().encode(`${BLOB_PREFIX}${randomHex}`);
}

/** Recover the service id from a blob; throws on anything malformed. */
export function serviceIdFromKeychainBlob(blob: Uint8Array): string {
  if (!isKeychainBlob(blob)) {
    throw new Error("keychain-blob: malformed blob");
  }
  return new TextDecoder().decode(blob).slice(BLOB_PREFIX.length);
}
