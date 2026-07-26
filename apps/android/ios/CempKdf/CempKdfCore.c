/* See CempKdfCore.h for the contract and parameter notes. */

#include "CempKdfCore.h"

#include <stdlib.h>
#include <string.h>

#include "argon2.h"
#include "crypto_scrypt.h"

/* Passwords/salts arrive hex-encoded; the vault's passwords are short and
 * salts are 16 bytes, but params are recorded in the vault file, so accept
 * anything sane and bound it to catch bridge bugs early. */
#define MAX_INPUT_BYTES 4096
#define MAX_OUT_BYTES 1024

static void
wipe(void *p, size_t n)
{
	volatile uint8_t *v = (volatile uint8_t *)p;

	while (n--)
		*v++ = 0;
}

static int
hexval(int c)
{
	if (c >= '0' && c <= '9')
		return (c - '0');
	if (c >= 'a' && c <= 'f')
		return (c - 'a' + 10);
	if (c >= 'A' && c <= 'F')
		return (c - 'A' + 10);
	return (-1);
}

/* Decode hex into a fresh buffer (caller frees). Empty string decodes to a
 * zero-length buffer (out may then be NULL). Returns length or -1. */
static int
hexdecode(const char *hex, uint8_t **out)
{
	size_t n, i;
	uint8_t *buf;

	if (hex == NULL)
		return (-1);
	n = strlen(hex);
	if (n % 2 != 0 || n / 2 > MAX_INPUT_BYTES)
		return (-1);
	if (n == 0) {
		*out = NULL;
		return (0);
	}
	if ((buf = malloc(n / 2)) == NULL)
		return (-1);
	for (i = 0; i < n / 2; i++) {
		int hi = hexval((uint8_t)hex[2 * i]);
		int lo = hexval((uint8_t)hex[2 * i + 1]);

		if (hi < 0 || lo < 0) {
			wipe(buf, n / 2);
			free(buf);
			return (-1);
		}
		buf[i] = (uint8_t)((hi << 4) | lo);
	}
	*out = buf;
	return ((int)(n / 2));
}

static void
hexencode(const uint8_t *buf, size_t len, char *out)
{
	static const char digits[] = "0123456789abcdef";
	size_t i;

	for (i = 0; i < len; i++) {
		out[2 * i] = digits[buf[i] >> 4];
		out[2 * i + 1] = digits[buf[i] & 0xf];
	}
	out[2 * len] = '\0';
}

int
cemp_kdf_argon2id_hex(const char *password_hex, const char *salt_hex,
    uint32_t m_kib, uint32_t t, uint32_t p, uint32_t out_bytes,
    char *out_hex, size_t out_hex_len)
{
	uint8_t *pwd = NULL, *salt = NULL, *out = NULL;
	int pwdlen, saltlen, rc, ret = 1;

	if (out_hex == NULL || out_bytes == 0 || out_bytes > MAX_OUT_BYTES ||
	    out_hex_len < (size_t)out_bytes * 2 + 1)
		return (1);
	pwdlen = hexdecode(password_hex, &pwd);
	saltlen = hexdecode(salt_hex, &salt);
	if (pwdlen < 0 || saltlen < 0)
		goto out;
	if ((out = malloc(out_bytes)) == NULL)
		goto out;
	rc = argon2_hash(t, m_kib, p, pwd, (size_t)pwdlen, salt,
	    (size_t)saltlen, out, out_bytes, NULL, 0, Argon2_id,
	    ARGON2_VERSION_NUMBER);
	if (rc != ARGON2_OK)
		goto out;
	hexencode(out, out_bytes, out_hex);
	ret = 0;
out:
	if (pwd != NULL) {
		wipe(pwd, (size_t)(pwdlen > 0 ? pwdlen : 0));
		free(pwd);
	}
	if (salt != NULL) {
		wipe(salt, (size_t)(saltlen > 0 ? saltlen : 0));
		free(salt);
	}
	if (out != NULL) {
		wipe(out, out_bytes);
		free(out);
	}
	return (ret);
}

int
cemp_kdf_scrypt_hex(const char *password_hex, const char *salt_hex,
    uint32_t log_n, uint32_t r, uint32_t p, uint32_t out_bytes,
    char *out_hex, size_t out_hex_len)
{
	uint8_t *pwd = NULL, *salt = NULL, *out = NULL;
	uint64_t n;
	int pwdlen, saltlen, rc, ret = 1;

	if (out_hex == NULL || out_bytes == 0 || out_bytes > MAX_OUT_BYTES ||
	    out_hex_len < (size_t)out_bytes * 2 + 1 || log_n >= 63)
		return (1);
	pwdlen = hexdecode(password_hex, &pwd);
	saltlen = hexdecode(salt_hex, &salt);
	if (pwdlen < 0 || saltlen < 0)
		goto out;
	if ((out = malloc(out_bytes)) == NULL)
		goto out;
	n = (uint64_t)1 << log_n;
	rc = crypto_scrypt(pwd, (size_t)pwdlen, salt, (size_t)saltlen, n, r,
	    p, out, out_bytes);
	if (rc != 0)
		goto out;
	hexencode(out, out_bytes, out_hex);
	ret = 0;
out:
	if (pwd != NULL) {
		wipe(pwd, (size_t)(pwdlen > 0 ? pwdlen : 0));
		free(pwd);
	}
	if (salt != NULL) {
		wipe(salt, (size_t)(saltlen > 0 ? saltlen : 0));
		free(salt);
	}
	if (out != NULL) {
		wipe(out, out_bytes);
		free(out);
	}
	return (ret);
}
