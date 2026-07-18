#!/usr/bin/env bash
# Reproducible-build check (spec Phase 11 task 15): the cemp-message-type
# riscv64 binary must be byte-identical across two clean builds. Prints both
# code hashes and fails on any difference.
set -euo pipefail

cd "$(dirname "$0")/.."
BIN=target/riscv64imac-unknown-none-elf/release/cemp-message-type

hash_of() {
  python3 - "$BIN" <<'EOF'
import hashlib, sys
print(hashlib.blake2b(open(sys.argv[1], 'rb').read(), digest_size=32, person=b'ckb-default-hash').hexdigest())
EOF
}

echo "== build 1 =="
cargo clean --quiet -p cemp-message-type 2>/dev/null || true
cemp-message-type/build.sh | grep -E "codeHash|Finished|rwx"
H1="$(hash_of)"
echo "codeHash(1): 0x$H1"

echo "== build 2 (after touching the source) =="
touch cemp-message-type/src/main.rs
cemp-message-type/build.sh | grep -E "codeHash|Finished|rwx"
H2="$(hash_of)"
echo "codeHash(2): 0x$H2"

if [ "$H1" != "$H2" ]; then
  echo "FAIL: builds are NOT reproducible ($H1 != $H2)" >&2
  exit 1
fi
echo "OK: reproducible — 0x$H1 (expected 0xd172d3bfb46d2e2f8f0e1c24139d3851010776205d66cec235dca34ec52234b8)"
[ "$H1" = "d172d3bfb46d2e2f8f0e1c24139d3851010776205d66cec235dca34ec52234b8" ]
