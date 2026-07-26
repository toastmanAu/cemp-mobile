#!/bin/sh
# Build the C KDF core + conformance harness with plain gcc (no dependencies
# beyond libc; argon2 is built with ARGON2_NO_THREADS so pthread is not even
# required) and run the vault KDF vectors. Exits non-zero on any mismatch.
set -eu

cd "$(dirname "$0")"

CC=${CC:-gcc}
CFLAGS="-O2 -std=c99 -Wall -Wextra -DARGON2_NO_THREADS"

ARGON2_INC="-Ivendor/argon2/include -Ivendor/argon2/src"
SCRYPT_INC="-Ivendor/scrypt/lib-platform/crypto -Ivendor/scrypt/lib/crypto \
-Ivendor/scrypt/libcperciva/alg -Ivendor/scrypt/libcperciva/cpusupport \
-Ivendor/scrypt/libcperciva/util"

SRC="harness.c \
vendor/argon2/src/argon2.c vendor/argon2/src/core.c \
vendor/argon2/src/encoding.c vendor/argon2/src/ref.c \
vendor/argon2/src/thread.c vendor/argon2/src/blake2/blake2b.c \
vendor/scrypt/lib/crypto/crypto_scrypt-ref.c \
vendor/scrypt/libcperciva/alg/sha256.c \
vendor/scrypt/libcperciva/util/insecure_memzero.c"

mkdir -p build
# shellcheck disable=SC2086
$CC $CFLAGS $ARGON2_INC $SCRYPT_INC $SRC -o build/kdf-harness

./build/kdf-harness vectors.txt
