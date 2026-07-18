/**
 * Mobile vault creation profile (native-engine era): OWASP-minimum argon2id,
 * computed by the native Bouncy Castle module — see
 * apps/android/src/platform/native-kdf.ts and the README's KDF section.
 * Recorded in the vault file (rule 13).
 */
import type { KdfOptions } from "@cemp/secure-vault";

export const MOBILE_VAULT_KDF: KdfOptions = { alg: "argon2id", m: 19_456, t: 2, p: 1 };
