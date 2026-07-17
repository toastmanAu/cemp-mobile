# CEMP on-chain contracts

Rust workspace for CEMP's on-chain scripts.

## Members

- `cemp-message-type/` — the CEMP message type script: a minimal on-chain
  validator for the 81-byte discovery args (`version || route_tag ||
conversation_tag || message_nonce`, ckd.txt §6, protocol spec §6). The
  platform-neutral logic is host-testable; the CKB-VM entry builds for
  riscv64 (see the crate README).
- `deployment/` — deployment records (code hashes, out points, networks) for
  every contract release. Nothing is deployed yet; the planned
  cemp-message-type deployment is recorded there.

## Relationship to the ML-DSA lock

CEMP does not ship its own lock: message cells are locked by the deployed
ML-DSA-65 lock from [ckb-mldsa-lock](https://github.com/toastmanAu/ckb-mldsa-lock).
Grounding on deployed testnet identifiers, the v1/v2 format differences, and
the mainnet readiness gate lives in
[`../docs/grounding/reference-projects.md`](../docs/grounding/reference-projects.md).
Per AGENTS.md rule 12, mainnet stays disabled until that lock deployment and
the signing implementation pass the readiness gate.

## Build

```bash
cargo test   # host-side checks (validation logic + constants)

# on-chain binary (riscv64, ckb-std):
cd cemp-message-type && ./build.sh
```
