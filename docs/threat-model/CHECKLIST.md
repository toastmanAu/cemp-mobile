# Phase 11 security checklist (mainnet readiness gate)

Status of the 16 hardening tasks (ckd.txt Phase 11). Evidence links point at
the code/tests that prove each item; items requiring action outside this
repository are marked OPEN with their owner.

## Tasks

1. **Threat-model every trust boundary** — `docs/threat-model/README.md` +
   this checklist: vault file, keystore, RPC/indexer, cell data, scanned QR,
   sync workers, journals, platform seams (Metro/Gradle), background
   scheduling. Each boundary has a documented parser/validator (rule 4) with
   a hostile-input test battery. ✅
2. **Fuzz all parsers** — Molecule codecs: ~10k-case fast-check suites
   (`packages/cemp-core/src/codec/malformed.property.test.ts`). Added:
   contact bundle + fingerprint (`hardening-fuzz.test.ts`), vault file
   (`packages/cemp-secure-vault/src/hardening-fuzz.test.ts`), type args +
   RPC parsers (`packages/cemp-ckb/src/hardening.test.ts`). ✅
3. **Corrupted indexer responses** — strict shape validation on every
   response (`client.ts` parsers); hostile-response battery in
   `packages/cemp-ckb/src/hardening.test.ts`. ✅
4. **Malicious cell data** — discovery pre-filters (81-byte args, prefix,
   size caps, `discovery.ts`), envelope validation before decapsulation,
   per-chunk size cap before reassembly (`packages/cemp-images/src/receive.ts`
   - test). ✅
5. **Oversized image declarations** — `checkManifest` rejects declared
   plaintext above the protocol maximum and inconsistent
   encrypted/plaintext/chunk-count triples BEFORE download
   (`packages/cemp-images/src/manifest.ts` + test). ✅
6. **Decompression bombs** — same guards as (5), plus per-chunk caps (4) and
   GCM-tag size consistency; a lying manifest is rejected without any fetch. ✅
7. **Repeated and replayed messages** — idempotency keys end to end:
   `logical_message_id` UNIQUE, `incoming:<envelope-id>` dedup (replay with a
   NEW outpoint collapses — `workers.test.ts` "replayed message"), journal
   resume for outbound. ✅
8. **Route-tag spam** — discovery drops invalid cells without stalling and
   the cursor advances (`workers.test.ts` "route-tag spam"), per-cell
   outpoint leases, incoming rate limits (9). ✅
9. **Per-contact and global rate limits** — `RateLimiter` token buckets
   (`packages/cemp-ckb/src/rate-limit.ts`, persisted in schema v5
   `rate_limits`), enforced at ingestion in the discovery worker; defaults
   60/hour per contact, 600/hour global. ✅ (outgoing enforcement = app
   composer wiring, same limiter)
10. **Block/report controls** — `contacts.blocked` (schema v5) enforced at
    ingestion, `ContactRepository.report` records `security_events` rows;
    history never deleted (rule 8). ✅
11. **Transaction simulation** — `CempClient.dryRunTransaction`
    (`dry_run_transaction`, same strict wire validation as broadcast). ✅
12. **Crash-safe transaction journals** — journal-before-broadcast (rule 6)
    with resume everywhere: publisher (purpose-embedded ids), lifecycle
    batches, attachment chunk/group publishes; resume paths tested
    (`publisher.test.ts`, `lifecycle.test.ts`, `send.ts`). ✅
13. **Log redaction** — `redactSecrets` (`packages/cemp-crypto/src/redact.ts`):
    ≥128-char hex and ≥6-word BIP39 runs masked; tx hashes/ids preserved. ✅
14. **Dependency vulnerability scanning** — `pnpm audit:deps`
    (`pnpm audit --prod --audit-level=high`), run 2026-07-18: 2 findings,
    both OFF the crypto/signing path: `fast-xml-parser` <5.7.0 (moderate,
    RN CLI build tooling), `elliptic` ≤6.6.1 (low, transitive via
    @ckb-ccc/core joyid packages — CEMP signs with ML-DSA only, secp256k1 is
    unused). Re-check on every dependency bump. ✅
15. **Reproducible builds** — `contracts/cemp-message-type/verify-reproducible.sh`:
    two clean builds → identical blake2b-256 codeHash
    `0xd172d3bf…52234b8` (matches the testnet deployment record). ✅
16. **Commission independent review** — **OPEN** (owner: project lead).
    Request prepared: `docs/review/INDEPENDENT-REVIEW-REQUEST.md`, covering
    ML-DSA lock, sighash implementation, key derivation, vault, Molecule
    parsers, reclaim protocol. This is the LAST open mainnet blocker.

## Mainnet blockers (explicitly resolved or outstanding)

- **Protocol serialization frozen** — v1 protocol, codecs, golden vectors,
  migration discipline in place (AGENTS.md rule 1). ✅
- **ML-DSA signing correctness** — v2 CighashAll signer proven byte-exact vs
  the Rust harness and accepted on-chain in 10+ live testnet transactions
  (incl. the §20 lifecycle and the 2026-07-18 rotation). ✅
- **Testnet beta without unreconciled capacity loss** — reference client
  `reconcile` step re-verified after every run; latest reconcile (2026-07-17)
  exact to the shannon. ✅
- **External review** — OPEN (task 16). Mainnet stays disabled
  (AGENTS.md rule 12) until the review closes and its findings are resolved.
