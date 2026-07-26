/*
 * CempKdfCore — the KDF derivation facade shared by the CempKdf React
 * Native bridge module (CempKdf.m) and the conformance XCTest
 * (CempMobileTests/CempKdfTests.m).
 *
 * Bridge semantics match the Android CempKdf Kotlin module exactly:
 * lowercase hex in (password, salt), lowercase hex out (derived key).
 *
 * Parameter subtleties (see tools/kdf-c-core/README.md):
 *   - argon2id: argon2_hash(..., Argon2_id, ARGON2_VERSION_NUMBER) — version
 *     0x13, no secret, no associated data, ARGON2_DEFAULT_FLAGS (clears
 *     password + memory). m_kib is in KiB.
 *   - scrypt: the vault stores logN; the C API takes N = (uint64_t)1 << logN.
 *   - Password bytes are the decoded hex as-is (the JS side UTF-8 encodes
 *     the password as typed, no NFKC normalisation).
 *
 * All intermediate buffers holding password or key material are wiped.
 */

#ifndef CEMP_KDF_CORE_H
#define CEMP_KDF_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Derive with argon2id. m_kib = memory in KiB, t = iterations, p = lanes.
 * out_hex must hold at least 2 * out_bytes + 1 chars; on success it
 * receives the lowercase hex derived key (NUL-terminated).
 * Returns 0 on success, non-zero on any error (bad hex, bad params,
 * derivation failure).
 */
int cemp_kdf_argon2id_hex(const char *password_hex, const char *salt_hex,
    uint32_t m_kib, uint32_t t, uint32_t p, uint32_t out_bytes,
    char *out_hex, size_t out_hex_len);

/*
 * Derive with scrypt. log_n gives N = 2^log_n; r, p as in RFC 7914.
 * Same output contract as cemp_kdf_argon2id_hex.
 */
int cemp_kdf_scrypt_hex(const char *password_hex, const char *salt_hex,
    uint32_t log_n, uint32_t r, uint32_t p, uint32_t out_bytes,
    char *out_hex, size_t out_hex_len);

#ifdef __cplusplus
}
#endif

#endif /* CEMP_KDF_CORE_H */
