# CEMP on-chain contracts

Rust workspace for CEMP's on-chain scripts.

## Members

- `cemp-message-type/` — the CEMP message type script (placeholder crate; the
  actual contract lands in a later phase, see ckd.txt §6 and Phase 1/11).
  Until it exists, cell discovery uses the indexing-type convention described
  in the spec (version || route_tag || conversation_tag || message_nonce).
- `deployment/` — deployment records (code hashes, out points, networks) for
  every contract release. Nothing is deployed yet.

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
cargo test   # host-side checks for now; on-chain builds target riscv64 later
```
