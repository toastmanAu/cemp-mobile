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

---

## Independent review remediation (2026-07-18, post-fable-review)

The independent review (`docs/review/INDEPENDENT-REVIEW-REPORT.md`) ran after
the initial checklist. Resolutions:

| Finding                                            | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A (CRITICAL, rotation trust forgeable)**         | FIXED. `verifyRotationLinkOnChain` (`packages/cemp-ckb/src/rotation-verify.ts`) binds every link to the transaction graph: the successor's creating tx must consume the predecessor's outpoint — the retiring key's authorization, not a data field. The reference client's verify-rotation step enforces it live (re-verified on testnet 2026-07-18: "tx-graph binding ✓"). Forge case covered by unit tests. Structural-only validation now documented as insufficient in `profile-trust.ts`. |
| **E1 (journaled-uncommitted wedge)**               | FIXED. Schema v6 `outgoing_transactions.tx_hex` stores the signed wire tx (rule-6-complete journal). `resumeJournaledBroadcast` (monitor.ts): committed → done; mempool → wait; unknown → REBROADCAST from journaled bytes; rejected/double-spend → `JournaledAbandonedError` → mark abandoned + requeue via the new legal retry edge `reclaim_pending → reclaim_queued`. Applied in lifecycle, publisher, and both image paths.                                                                |
| **E2 (illegal reclaim_queued→reclaimed)**          | FIXED. Dead-cell path now walks reclaim_queued → reclaim_pending → reclaimed.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **E3 (reclaimable bucket never funded)**           | FIXED. Publisher records message-cell capacity in the journal and reserves it at commit; ack processing moves it to reclaimable from the journal record; reclaim releases reclaimable→available. All three transitions have production callers and integration-test coverage.                                                                                                                                                                                                                   |
| **E4 (`unknown` treated as `dead`)**               | FIXED in both lifecycle consumers: only explicit `dead` acts; `unknown` leaves state queued for the next round (rule 4/7).                                                                                                                                                                                                                                                                                                                                                                      |
| **E5 (double-commit double-credit)**               | FIXED. `markStateIf` compare-and-swap: exactly one caller wins submitted→committed; release only by the winner.                                                                                                                                                                                                                                                                                                                                                                                 |
| **E6 (pending worker pre-marks reclaim)**          | FIXED. pending-transactions never pre-marks reclaim txs; the lifecycle resume path owns finalization.                                                                                                                                                                                                                                                                                                                                                                                           |
| **E7 (gross-of-fee accounting)**                   | FIXED. Released amounts are net of fee; the fee part is written off via `recordFeeBurn` (reclaimable bucket drains to zero).                                                                                                                                                                                                                                                                                                                                                                    |
| **E8 (swallowed acks)**                            | FIXED. Receipts are processed on EVERY discovery pass (idempotent), not only on first insert.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **E9 (no autonomous reclaim)**                     | DISCLOSED here + threat-model note: reclaim is recipient-gated by design (the sender retains authority, the recipient's ack is the trigger); a recipient who never acks pins capacity until a manual reclaim. Manual/TTL reclaim is a product follow-up.                                                                                                                                                                                                                                        |
| **E10 (attachment group resume gaps)**             | FIXED. Resume rebroadcasts journaled bytes, marks committed, and releases the journaled capacity.                                                                                                                                                                                                                                                                                                                                                                                               |
| **S1 (unchecked single-group assumption)**         | FIXED. `assertAllInputsLockedBy` before every sign.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **B (redaction not wired)**                        | FIXED at the reference-client log sink (`redactSecrets` on every line). Documented limitation retained: 32-byte secrets are byte-indistinguishable from public ids; tagging, not length, is the complete answer for those.                                                                                                                                                                                                                                                                      |
| **V1 (autoLockSeconds unauthenticated)**           | FIXED. App-side ceiling `MAX_AUTO_LOCK_SECONDS = 3600` clamps the file value on every read; encrypted-payload home is format-v2 work.                                                                                                                                                                                                                                                                                                                                                           |
| **V2 (native bridge string secrets)**              | PARTIAL. Kotlin buffers zeroed in `finally` (password + derived key). The RN bridge string serialization itself is a platform limit — documented; the noble path remains the zeroisation reference.                                                                                                                                                                                                                                                                                             |
| **C1 (unchecked discriminants)**                   | FIXED. Range checks: body_type (known set), receipt_request (≤0x03), receipt status (0x00–0x06 enum), revoked (0                                                                                                                                                                                                                                                                                                                                                                                | 1), supported_attachments (2-bit mask). |
| **C2 (lenient hex parser)**                        | FIXED. cemp-images uses strict hexToBytes everywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **V3 (VEK on auth failure)**                       | FIXED. VEK wiped on payload-decrypt failure in both unlock paths.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **V4 (unbounded biometric blob / file)**           | FIXED. 64 KiB file cap, 512 B biometric-blob cap, enforced before parse.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **V5 (no KDF floor)**                              | ACCEPTED RISK, documented: caps prevent DoS; a weak-_PARAMS file cannot be crafted to unwrap (KEK is derived from recorded params; editing params guarantees unwrap failure). No floor needed.                                                                                                                                                                                                                                                                                                  |
| **P1 (suite red: boundary test path)**             | ALREADY FIXED in `cc87453` (the review ran against the pre-fix tree; the boundary guard is functional).                                                                                                                                                                                                                                                                                                                                                                                         |
| **P2 (classical upgrade key over PQ lock)**        | DISCLOSED here: the testnet ML-DSA lock deploy is Type-ID-upgradeable by a secp256k1 key — a classically-breakable trust root until the immutable mainnet deployment. Mainnet cutover MUST deploy immutably (data1/code reference) and disclose this to users.                                                                                                                                                                                                                                  |
| **S2 (no on-chain acceptance from the TS path)**   | DISPUTED with evidence: the entire TS builder+signer stack broadcast live on testnet — deploy `0x25727f76…`, profiles, send `0xcb221f6d…`, respond `0x726c431d…`, ack-reclaim `0x8e525492…`, rotation `0x14c2c036…` (2026-07-18) — all accepted by the real on-chain scripts. The Rust harness additionally covers byte-exactness.                                                                                                                                                              |
| **S3 (signOnlyTransaction placeholder asymmetry)** | ACCEPTED (API note; completeFeeBy re-pads every iteration).                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Gate status after remediation:** all HIGH/CRITICAL findings resolved; suite
449 passed + 1 skipped. Remaining pre-mainnet items: immutable mainnet
deployment (P2), the re-review of these deltas, and the E9/manual-reclaim
product follow-up.
