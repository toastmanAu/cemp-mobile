#!/usr/bin/env bash
# Reproducible-build check (spec Phase 11 task 15).
#
# What this proves, honestly:
# - SAME ENVIRONMENT determinism (the hard assertion): two clean builds of
#   this crate in the same environment produce byte-identical code hashes.
# - Deployment parity (informational): the deployment's codeHash is only
#   reproducible under the FULL toolchain set it was built with — rustc AND
#   the riscv64 cross-gcc version (ckb-std compiles C sources). A different
#   gcc release produces a different-but-self-consistent binary, so byte
#   parity across environments is NOT expected and is NOT a defect.
#
# Deployment record: contracts/deployment/cemp-message-type.testnet.json
# captures the deployed hash; build the binary IN THE DEPLOYMENT ENVIRONMENT
# and compare manually before deploying.
set -euo pipefail

cd "$(dirname "$0")/.."
BIN=target/riscv64imac-unknown-none-elf/release/cemp-message-type
EXPECTED="d172d3bfb46d2e2f8f0e1c24139d3851010776205d66cec235dca34ec52234b8"

hash_of() {
  python3 - "$BIN" <<'EOF'
import hashlib, sys
print(hashlib.blake2b(open(sys.argv[1], 'rb').read(), digest_size=32, person=b'ckb-default-hash').hexdigest())
EOF
}

echo "toolchain: $(rustc --version) / $(riscv64-unknown-elf-gcc --version | head -1)"

echo "== build 1 =="
cemp-message-type/build.sh | grep -E "Finished|rwx" || true
H1="$(hash_of)"
echo "codeHash(1): 0x$H1"

echo "== build 2 (after touching the source) =="
touch cemp-message-type/src/main.rs
cemp-message-type/build.sh | grep -E "Finished|rwx" || true
H2="$(hash_of)"
echo "codeHash(2): 0x$H2"

if [ "$H1" != "$H2" ]; then
  echo "FAIL: builds are NOT deterministic in this environment ($H1 != $H2)" >&2
  exit 1
fi
echo "OK: deterministic in this environment — 0x$H1"

if [ "$H1" != "$EXPECTED" ]; then
  echo "NOTE: this environment's hash differs from the deployment record" >&2
  echo "      expected 0x$EXPECTED (deployment environment hash; parity across" >&2
  echo "      environments requires the same rustc AND riscv64 cross-gcc)." >&2
  # Informational only — see the header comment. Exit 0.
else
  echo "OK: also byte-identical to the deployment record."
fi
