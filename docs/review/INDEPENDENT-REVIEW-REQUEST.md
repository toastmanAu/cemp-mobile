# Independent security review — request for proposals

**Project:** CEMP Mobile — Android-first post-quantum messenger over Nervos CKB cells.
**Repository:** https://github.com/toastmanAu/cemp-mobile (public, commit `main`).
**Requested by:** project lead. **Date:** 2026-07-18.
**Status of the codebase at request time:** 410 unit tests + 1 skipped green;
full message lifecycle proven live on CKB testnet (see §Evidence).

## Scope (ckd.txt Phase 11 task 16)

The review MUST cover, in priority order:

1. **ML-DSA-65 v2 lock usage and sighash implementation**
   - `packages/cemp-crypto/src/mldsa-v2.ts` and `packages/cemp-ckb/src/cighash.ts`
     (TypeScript port), `tools/signing-harness/` (Rust reference),
     `docs/grounding/mldsa-v2-signing-pipeline.md` (normative algorithm doc).
   - Verify the CighashAll stream construction, the FIPS-204 context framing
     (single-wrap, `CKB-MLDSA-LOCK`), witness/lock-arg layouts, and the
     noble↔fips204 byte-exactness claims (golden vectors:
     `packages/cemp-test-vectors/vectors/mldsa-v2.json`).
2. **Key derivation** — BIP39 → domain-separated HKDF sub-seeds, rotation
   derivation (`packages/cemp-crypto/src/identity.ts`, `domains.ts`).
3. **Vault** — `packages/cemp-secure-vault`: file format v1, multi-slot VEK
   design, KDF profiles (desktop RFC 9106 / mobile OWASP-min via the native
   engine), wrap slots, zeroisation claims vs JavaScript reality.
4. **Molecule parsers** — `packages/cemp-core/src/codec/` + the normative
   schema `packages/cemp-core/schemas/cemp-v1.mol` and
   `docs/protocol/CEMP-PROTOCOL-V1.md`.
5. **Reclaim protocol** — sender-owned cells, receipt/ack flow, batch reclaim
   (`packages/cemp-ckb/src/lifecycle.ts`), capacity accounting
   (`packages/cemp-database/src/repositories/balances.ts`).

Out of scope: Android UI code, pnpm/Gradle build plumbing, third-party
libraries (except where our usage is suspect).

## Evidence provided to the reviewer

- **Live testnet transactions** (all independently RPC-verifiable):
  - §20 lifecycle: deploy `0x25727f76…`, send `0xcb221f6d…`, respond
    `0x726c431d…`, ack-reclaim `0x8e525492…`.
  - Profile rotation (2026-07-18): `0x14c2c036…c27e`, block 21,785,593.
- **Golden vectors** — serialization, envelope, ML-DSA v2, vault
  (`packages/cemp-test-vectors/vectors/`).
- **Fuzz/property suites** — ~10k-case malformed-input suites plus the Phase
  11 hardening batteries (`hardening.test.ts` / `hardening-fuzz.test.ts`).
- **Security checklist** — `docs/threat-model/CHECKLIST.md` (this gate's
  current status, incl. the dependency-audit assessment).

## Questions we explicitly ask

1. Are there signature-forgery or malleability paths in the v2 CighashAll
   stream as ported (length prefixes, dep/input/output ordering, fee
   completion interactions with CCC 1.12.5)?
2. Is the rotation derivation (`HKDF(subSeed, nil, domain‖u32le(N))`)
   sound as a key-lineage mechanism, and is the on-chain back-reference +
   structural chain validation sufficient for contact trust?
3. Does the multi-slot VEK design introduce any downgrade path (biometric
   slot vs password slot), and is the native-engine KDF swap (recorded
   params, rule 13) safe against profile-stripping by a hostile vault file?
4. Any capacity-loss edge in the reclaim lifecycle: crash windows, partial
   batches, already-spent inputs, conflicting watchers?
5. Metadata-leakage observations beyond `docs/threat-model/README.md`'s
   disclosures (route tags, timing, cell sizes).

## Deliverable expected

A written report with findings ranked by severity, each with a concrete
reproduction or reference to code. Mainnet remains disabled (AGENTS.md rule 12) until the report is in and all HIGH/CRITICAL findings are resolved.
