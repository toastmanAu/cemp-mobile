/*
 * kdf-c-core conformance harness — the C core the iOS `CempKdf` native
 * module will wrap (docs/architecture/ios-prep.md, Task 2).
 *
 * Reads a vectors file (see vectors.txt for the format) and runs each case
 * through the vendored C implementations:
 *
 *   - argon2id  (RFC 9106), phc-winner-argon2 reference library
 *   - scrypt    (RFC 7914), Tarsnap scrypt reference implementation
 *
 * The per-line parameters mirror the bridge semantics the Swift wrapper will
 * expose: hex-encoded password/salt in, hex-encoded derived key out. The
 * expected outputs are pinned in packages/cemp-secure-vault/src/kdf.test.ts
 * (@noble/hashes, reference-checked); this harness proves byte-compatibility.
 *
 * Exit status: 0 if every case matches, 1 on any mismatch or usage error.
 *
 * Build: see run-vectors.sh (plain gcc, libc only, ARGON2_NO_THREADS).
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "argon2.h"
#include "crypto_scrypt.h"

#define MAX_LINE 1024
#define MAX_BYTES 128 /* passwords/salts in the vectors are far smaller */
#define MAX_OUT 64    /* KEK_BYTES is 32; allow up to 64 */

/* Wipe a buffer that held password material (vectors here are public, but
 * the Swift wrapper will handle real secrets — keep the habit). */
static void
wipe(void * p, size_t n)
{
	volatile uint8_t * v = (volatile uint8_t *)p;

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

/* Decode hex into buf; "-" means the empty byte string. Returns length or -1. */
static int
hexdecode(const char * hex, uint8_t * buf, size_t buflen)
{
	size_t n;
	size_t i;

	if (strcmp(hex, "-") == 0)
		return (0);
	n = strlen(hex);
	if (n % 2 != 0 || n / 2 > buflen)
		return (-1);
	for (i = 0; i < n / 2; i++) {
		int hi = hexval(hex[2 * i]);
		int lo = hexval(hex[2 * i + 1]);

		if (hi < 0 || lo < 0)
			return (-1);
		buf[i] = (uint8_t)((hi << 4) | lo);
	}
	return ((int)(n / 2));
}

static void
hexencode(const uint8_t * buf, size_t len, char * out)
{
	size_t i;

	for (i = 0; i < len; i++)
		sprintf(out + 2 * i, "%02x", buf[i]);
}

/*
 * Run one vector. alg is "argon2id" (p1 = m in KiB, p2 = t, p3 = lanes) or
 * "scrypt" (p1 = logN, p2 = r, p3 = p). Returns 0 on byte-identical match.
 */
static int
run_case(const char * name, const char * alg, unsigned long p1,
    unsigned long p2, unsigned long p3, const uint8_t * pwd, size_t pwdlen,
    const uint8_t * salt, size_t saltlen, const uint8_t * expected,
    size_t outlen)
{
	uint8_t got[MAX_OUT];
	char gothex[2 * MAX_OUT + 1];
	int rc;

	if (outlen > MAX_OUT) {
		printf("FAIL %-20s outlen %zu exceeds harness max\n", name, outlen);
		return (1);
	}

	if (strcmp(alg, "argon2id") == 0) {
		/*
		 * argon2_hash() with type Argon2_id and version
		 * ARGON2_VERSION_NUMBER (0x13 = v1.3). This is exactly the
		 * profile @noble/hashes argon2id implements: no secret, no
		 * associated data, ARGON2_DEFAULT_FLAGS (clears password and
		 * memory). m is in KiB on both sides.
		 */
		rc = argon2_hash((uint32_t)p2, (uint32_t)p1, (uint32_t)p3,
		    pwd, pwdlen, salt, saltlen, got, outlen, NULL, 0,
		    Argon2_id, ARGON2_VERSION_NUMBER);
		if (rc != ARGON2_OK) {
			printf("FAIL %-20s argon2 error: %s\n", name,
			    argon2_error_message(rc));
			return (1);
		}
	} else if (strcmp(alg, "scrypt") == 0) {
		uint64_t N;

		if (p1 >= 63) {
			printf("FAIL %-20s logN out of range\n", name);
			return (1);
		}
		N = (uint64_t)1 << p1;
		rc = crypto_scrypt(pwd, pwdlen, salt, saltlen, N,
		    (uint32_t)p2, (uint32_t)p3, got, outlen);
		if (rc != 0) {
			printf("FAIL %-20s crypto_scrypt error: %d\n", name,
			    rc);
			return (1);
		}
	} else {
		printf("FAIL %-20s unknown alg \"%s\"\n", name, alg);
		return (1);
	}

	hexencode(got, outlen, gothex);
	if (memcmp(got, expected, outlen) == 0) {
		printf("PASS %-20s %s\n", name, gothex);
		wipe(got, sizeof(got));
		return (0);
	}
	printf("FAIL %-20s\n  got      %s\n  expected ", name, gothex);
	{
		char exhex[2 * MAX_OUT + 1];

		hexencode(expected, outlen, exhex);
		printf("%s\n", exhex);
	}
	wipe(got, sizeof(got));
	return (1);
}

int
main(int argc, char ** argv)
{
	FILE * f;
	char line[MAX_LINE];
	unsigned int lineno = 0;
	unsigned int cases = 0;
	unsigned int failures = 0;

	if (argc != 2) {
		fprintf(stderr, "usage: %s <vectors-file>\n", argv[0]);
		return (1);
	}
	if ((f = fopen(argv[1], "r")) == NULL) {
		perror(argv[1]);
		return (1);
	}

	while (fgets(line, sizeof(line), f) != NULL) {
		char name[64], alg[16], pwdhex[2 * MAX_BYTES + 2];
		char salthex[2 * MAX_BYTES + 2], exphex[2 * MAX_OUT + 2];
		unsigned long p1, p2, p3, outlen;
		uint8_t pwd[MAX_BYTES], salt[MAX_BYTES], expected[MAX_OUT];
		int pwdlen, saltlen, explen;

		lineno++;
		if (line[0] == '#' || line[0] == '\n' || line[0] == '\0')
			continue;
		if (sscanf(line, "%63s %15s %lu %lu %lu %lu %257s %257s %129s",
		    name, alg, &p1, &p2, &p3, &outlen, pwdhex, salthex,
		    exphex) != 9) {
			fprintf(stderr, "%s:%u: malformed line\n", argv[1],
			    lineno);
			failures++;
			continue;
		}
		pwdlen = hexdecode(pwdhex, pwd, sizeof(pwd));
		saltlen = hexdecode(salthex, salt, sizeof(salt));
		explen = hexdecode(exphex, expected, sizeof(expected));
		if (pwdlen < 0 || saltlen < 0 || explen < 0 ||
		    (unsigned long)explen != outlen) {
			fprintf(stderr, "%s:%u: bad hex or outlen\n", argv[1],
			    lineno);
			failures++;
			continue;
		}
		cases++;
		failures += (unsigned int)run_case(name, alg, p1, p2, p3,
		    pwd, (size_t)pwdlen, salt, (size_t)saltlen, expected,
		    (size_t)outlen);
		wipe(pwd, sizeof(pwd));
	}
	fclose(f);

	if (cases == 0) {
		fprintf(stderr, "%s: no vector cases found\n", argv[1]);
		return (1);
	}
	printf("%u case(s), %u failure(s)\n", cases, failures);
	return (failures == 0 ? 0 : 1);
}
