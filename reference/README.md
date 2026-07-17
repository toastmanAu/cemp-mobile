# reference/

Vendored prototype code, kept for reading and comparison only.

**Rules (AGENTS.md):** never import from `reference/` in `packages/`, `apps/`,
`contracts/` or `tools/`; never edit it as if it were production code. It is
unreviewed prototype material that the real implementation consults and
deliberately deviates from.

## cemp-pq/

The CEMP-PQ prototype, merged from two local sources (2026-07-17):

- Library code (`index.js`, `tx-builder.js`, `index.d.ts`, `tx-builder.test.js`,
  `package.json`) from `~/chain-pay/packages/cemp-pq` — the newer copy, with
  network-parameterized lock constants and the notification-pointer fix.
- Docs and live-test harness (`README.md`, `live-test.js`, `derive-address.js`,
  `verify-txs.js`, `test.js`, `test-builder.js`, `package-lock.json`) from
  `~/ecms/cemp-pq` — canonical for documentation and on-chain verification records.
- `schemas/cemp-pq.mol` is byte-identical in both sources.

Known prototype shortcuts the production implementation must fix (details in
[`docs/grounding/reference-projects.md`](../docs/grounding/reference-projects.md)):

1. Targets the **deprecated v1 ML-DSA lock** whose signing digest covers only
   the transaction hash, not full sighash-all (ckb-mldsa-lock HIGH-1).
2. Derives the symmetric key with raw personalised BLAKE2b instead of HKDF.
3. Uses a recipient-owned notification cell, which conflicts with prompt
   sender reclamation (see ckd.txt §6 for the revised sender-owned model).
4. No BIP39/HKDF key derivation — raw demo seeds.
5. Hand-written Molecule serialization without generated codecs.
