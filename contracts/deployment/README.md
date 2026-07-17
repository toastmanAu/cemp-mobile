# Deployment records

Every CEMP contract deployment gets a record file here:

```json
{
  "network": "ckb_testnet",
  "contract": "cemp-message-type",
  "version": "0.1.0",
  "deployTxHash": "0x…",
  "outPointIndex": 0,
  "codeHash": "0x…",
  "hashType": "type|data1",
  "deployedAt": "YYYY-MM-DD",
  "sourceCommit": "…",
  "notes": "…"
}
```

Nothing is deployed yet. The ML-DSA-65 lock CEMP relies on is deployed and
documented externally — see `docs/grounding/reference-projects.md` §3 for its
testnet identifiers (and why the v1 deployment is deprecated).

## Planned deployments

### cemp-message-type (testnet, pending funded deploy task)

- `hashType`: `data1` — immutable code reference, no TYPE ID upgrade path,
  mirroring the mainnet-readiness posture (the script is tiny and versioned;
  a fix ships as a new code hash, not an in-place upgrade).
- `codeHash`: `0xb0d8497f78c22610d0c02a77235046ed62a006f6bce67b18fb18c5330aff0a0a`
  — blake2b-256 (`ckb-default-hash` personalization) of the release binary
  `contracts/target/riscv64imac-unknown-none-elf/release/cemp-message-type`
  (26672 bytes; rustc 1.92.0, ckb-std 1.1.0 — rebuild via
  `contracts/cemp-message-type/build.sh`).
- Deployment itself is a later task: it needs a funded testnet account and
  will fill in `deployTxHash` / `outPointIndex` in a record file here. The
  codeHash above is valid only for exactly this binary; the deploy task must
  recompute and record the hash of the binary it actually ships.
