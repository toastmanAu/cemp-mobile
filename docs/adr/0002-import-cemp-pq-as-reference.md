# ADR 0002: cemp-pq vendored as reference-only code

- Status: Accepted (2026-07-17)
- Context: Spec Phase 0 task 1: "Import the supplied CEMP-PQ code as reference,
  not as unreviewed production code." Two local copies exist; grounding showed
  chain-pay's copy has newer library code while ecms has the docs, live-test
  harness, and on-chain verification records
  (../grounding/reference-projects.md §1).
- Decision: Merge-vendor both into `reference/cemp-pq/` (library code from
  chain-pay, docs/harness from ecms). `reference/` is read-only; production
  packages never import from it (AGENTS.md). Its known shortcuts are documented
  in `reference/README.md` and tracked as Phase 1–4 corrections: v1 lock +
  tx-hash-only digest, non-HKDF key derivation, recipient-owned notification
  cell, no BIP39, hand-written Molecule.
- Consequences: ~92 KB of reference material with full provenance; prototype
  patterns (profile-on-Type-ID discovery, CCC fee/witness flow) are consultable
  without inheriting prototype risk.
