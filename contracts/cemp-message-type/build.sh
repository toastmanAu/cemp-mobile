#!/usr/bin/env bash
# Build the CEMP message type script for CKB-VM and print its identity
# (size + CKB blake2b-256 code hash). Deployment is a separate, later task.
set -euo pipefail

cd "$(dirname "$0")/.." # contracts/ workspace root

rustup target add riscv64imac-unknown-none-elf
cargo build --target riscv64imac-unknown-none-elf --release

BIN=target/riscv64imac-unknown-none-elf/release/cemp-message-type
ls -l "$BIN"

# CKB code hash = blake2b-256 with the "ckb-default-hash" personalization.
python3 - "$BIN" <<'EOF'
import hashlib, sys
data = open(sys.argv[1], 'rb').read()
print('codeHash: 0x' + hashlib.blake2b(data, digest_size=32, person=b'ckb-default-hash').hexdigest())
EOF
