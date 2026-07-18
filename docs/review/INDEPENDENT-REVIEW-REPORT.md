# Independent security review — CEMP Mobile (CellSend)

**Reviewer:** independent code review (agent-assisted, read-only).
**Date:** 2026-07-18.
**Commit context:** `main` (local worktree, clean). Build + full test suite executed.
**Scope:** the five priority areas of `docs/review/INDEPENDENT-REVIEW-REQUEST.md`
(ML-DSA v2 lock / sighash, key derivation & rotation, vault, Molecule parsers,
reclaim lifecycle). Android UI, build plumbing, and third-party libraries were
out of scope except where CEMP's _usage_ was suspect.

---

## 1. Verdict

The cryptographic core is in good shape. The ML-DSA-65 v2 CighashAll port is
**byte-exact** against the Rust reference and the deployed lock's framing, the
key-derivation tree is textbook-correct, the vault's multi-slot design has **no
KDF-downgrade path**, and the Molecule codec is one of the more robust hostile-
input parsers I have reviewed. Those four areas are close to mainnet-ready.

Two areas are **not** ready and gate the mainnet decision:

1. **Contact-rotation trust is structurally forgeable** (scope 2 / question 2).
   The rotation-chain validator trusts a self-declared cell-data field with no
   on-chain or signature binding. It contradicts the protocol spec's own stated
   security property and defeats the Phase 5 "blocking warning on unexpected key
   change" exit criterion. It is not yet reachable by an attacker only because
   the profile-rotation _discovery_ path it depends on has not shipped — so it
   must be fixed **before** that feature lands, not after.

2. **The reclaim pipeline has four HIGH capacity/availability defects** (scope 5 /
   question 4) that strand CKB capacity or permanently wedge reclaim in normal,
   attacker-free operation — including one accounting path that appears to throw
   on every real reclaim and is green only because a test funds a ledger bucket
   by hand.

Separately, the request's premise that the suite is "410 unit tests + 1 skipped
green" **no longer holds**: the current suite is 435 passed / **3 failed** / 1
skipped (439 total). See §6.

Recommended gate decision: **do not enable mainnet.** Resolve the rotation-trust
design (Finding A) and the four reclaim HIGHs (Findings E1–E4), re-green the
suite, then re-review the deltas.

---

## 2. Findings ranked by severity

| #      | Sev       | Area      | Finding                                                                                                                                      |
| ------ | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | CRITICAL¹ | Rotation  | Rotation-chain trust has no cryptographic / tx-graph binding — impersonation once rotation-discovery ships                                   |
| E1     | HIGH      | Reclaim   | Journaled-but-uncommitted reclaim tx permanently wedges the whole reclaim pipeline                                                           |
| E2     | HIGH      | Reclaim   | Already-spent `reclaim_queued` cell throws an illegal state transition, aborting all future batches                                          |
| E3     | HIGH      | Reclaim   | `releaseReclaimedCapacity` cannot succeed in production — the `reclaimable` ledger bucket is never funded                                    |
| E4     | HIGH      | Reclaim   | RPC `unknown` conflated with `dead` → live cells terminally marked reclaimed (capacity stranded)                                             |
| S1     | MEDIUM    | Sighash   | `signing.ts` never asserts resolved-input locks equal the signer's lock (single-group assumption unchecked)                                  |
| B      | MEDIUM    | Key deriv | `redactSecrets` cannot distinguish 32-byte secrets from 32-byte public ids, and is not wired to any log sink                                 |
| V1     | MEDIUM    | Vault     | `autoLockSeconds` — a real security control — lives in the **unauthenticated** `meta` block (evil-maid)                                      |
| V2     | MEDIUM    | Vault     | Native KDF bridge transports password + derived KEK as unwipeable hex strings                                                                |
| C1     | MEDIUM    | Codec     | Enum/discriminant bytes (`body_type`, `status`, `revoked`, …) pass `validate*` unchecked (latent, fail-safe today)                           |
| E5–E10 | MEDIUM    | Reclaim   | Double-credit race, gross-of-fee accounting, at-most-once ack stranding, no autonomous/aged reclaim (griefing), attachment-group resume gaps |
| S2     | LOW/INFO  | Sighash   | No end-to-end on-chain broadcast test from the TS builders (only Rust harness + mocks + upstream proof-of-life)                              |
| S3     | LOW       | Sighash   | `signOnlyTransaction` skips `ensurePlaceholderWitnesses` (API asymmetry, safe today)                                                         |
| C2     | LOW       | Codec     | `cemp-images` `hexToBytes` truncates odd-length / non-hex input instead of throwing                                                          |
| V3–V5  | LOW       | Vault     | VEK not zeroed on auth-failure path; unbounded biometric-slot / file size; no KDF-strength floor                                             |
| P1     | —         | Process   | Test suite is red: 3 failures in `platform-boundaries.test.ts` (broken path) — the boundary guard is non-functional                          |
| P2     | —         | Process   | Deployed v2 lock is Type-ID-upgradeable by a secp256k1 key — a quantum-breakable trust root over PQ verifiers until immutable mainnet deploy |

¹ CRITICAL _by impact_, currently gated by an unshipped feature — see Finding A
for the exploitability precondition. Treat as a hard pre-mainnet blocker.

---

## 3. Detailed findings

### A. CRITICAL — Contact-rotation trust is structurally forgeable

**Files.** `packages/cemp-core/src/profile-trust.ts:42-72` (`validateRotationChain`),
`:94-127` (`evaluateContactProfile`); `packages/cemp-ckb/src/builders.ts:55-59`
(profile cells use the stock Type-ID script), `:284-313` (client-side-only
back-reference check); `docs/protocol/CEMP-PROTOCOL-V1.md:118-146`;
`apps/reference-client/src/steps/verify-rotation.ts:48-64`.

**What is enforced today.** The _honest_ rotation builder
(`buildRotateProfileTx`) genuinely spends the predecessor profile cell as input 0
under the owner's ML-DSA lock and requires `previous_profile_id` to equal the
spent cell's type args. So a real rotation performed through CEMP's own tooling
is sound.

**The gap.** Nothing _forces_ a rotation to be built that way, and the verifier
never checks that it was. Profile cells carry only the **standard CKB Type-ID
script** (`TYPE_ID_CODE_HASH`), whose sole rule is Type-ID uniqueness — there is
no custom profile-type contract in `contracts/` (only `cemp-message-type`
exists, and it validates message-cell args only, per `contracts/cemp-message-type/src/lib.rs`).
Therefore `rotation_sequence` and `previous_profile_id` are ordinary,
unvalidated **cell-data** fields. `validateRotationChain` performs purely
structural, self-referential checks (`rotationSequence === i`, and
`previousProfileId` byte-equals the prior link's `profileId`) over whatever view
array the caller supplies. It never fetches the transaction that created a link,
never confirms that transaction actually consumed the claimed predecessor's
outpoint, and never verifies a signature.

This directly contradicts `CEMP-PROTOCOL-V1.md`, which states rotation chains are
validated by "checking signature continuity during contact trust evaluation."
No signature-continuity check exists.

**Exploitation.** Bob has TOFU-trusted Alice at `profile_id = P0`. Mallory (no
access to any of Alice's keys) mints her _own_ Type-ID cell — funded by her own
coins, under her own lock — whose data claims `previous_profile_id = P0`,
`rotation_sequence = 1`, and carries Mallory's ML-DSA / ML-KEM public keys.
`validateRotationChain([savedAliceView, malloryForgedView])` returns valid;
`evaluateContactProfile` returns `rotation-verified` rather than the blocking
`key-changed-blocking`. Bob silently starts encrypting to Mallory's KEM key and
trusting Mallory's signatures as "Alice, post-rotation." Full impersonation /
MITM, no warning shown.

**Why CRITICAL-but-gated.** No current code path feeds an attacker-supplied chain
into `evaluateContactProfile` automatically: the only caller
(`verify-rotation.ts`) builds the "old" half from the client's own honest local
record, and cross-profile "scan for cells claiming to be my contact's successor"
discovery (spec §5.5/§10) is **not implemented** — `discovery.ts` only handles
message-cell discovery. The moment that planned discovery feature ships, this
becomes directly exploitable. Two independent reviews (manual + the key-
derivation deep-dive) converged on this finding.

**Fix (pick one, ideally layered).**

- (a) Deploy a custom profile-type contract enforcing predecessor consumption
  and public-key continuity on-chain (strongest; contract-level).
- (b) Make chain validation walk `get_transaction` per link and confirm the
  creating tx actually consumed the prior link's real outpoint (client-side but
  transaction-graph-verified, not data-field-trusting).
- (c) Require an explicit ML-DSA signature by the _retiring_ key over the new
  profile's `(profile_id, ml_dsa_public_key, ml_kem_public_key)`, verified in
  `validateRotationChain` — this is what the spec already promises.

---

### E. HIGH — Reclaim lifecycle capacity & availability (question 4)

Rule 9 holds end-to-end: message cells are created under `sender.lockScript()`,
`buildReclaimTx` refuses any cell not locked by the signer, and CKB atomicity
means a batch reclaim never partially applies (a single dead input rejects the
whole tx). No path _bricks_ capacity permanently on-chain. But the automated
pipeline has four HIGH defects that strand capacity or wedge reclaim in normal
operation:

**E1 — Journaled-but-uncommitted tx permanently wedges reclaim.**
`lifecycle.ts:153-173,226-244`; `outgoing-transactions.ts:51-72`. The journal
records `txHash/purpose/state/fee/capacity` but **not the signed transaction
bytes**, so resume can only _wait_ for the hash, never rebroadcast. A crash
between journal-write and `sendTransaction`, or a `sendTransaction` throw (e.g.
a competing spend in the TOCTOU window between the liveness check at `:196` and
broadcast), leaves a `submitted` row for a tx the network never saw. Every later
`executeReclaimBatch` re-enters the resume branch, `getTransaction` returns
`unknown` forever, and `waitForTransactionCommit` times out and throws.
`runPendingTransactions` only handles `committed`/`rejected`, so the row stays
`submitted` forever — **reclaim for the whole wallet is dead** until manual DB
surgery. The same class exists in `MessagePublisher.publishText` and
`cemp-images/reclaim.ts`. Fix: journal the signed wire bytes (or split
`submitted`→`broadcast`), and add an `unknown`-after-N-polls → `abandoned`
requeue path.

**E2 — Already-spent `reclaim_queued` cell throws an illegal transition.**
`lifecycle.ts:202-205` vs `message-states.ts:87-89`, `messages.ts:183-188`. The
"already spent by us" branch calls `transitionMessage(rowId, "reclaimed")`, but
the state machine only permits `reclaim_pending → reclaimed`; `reclaim_queued →
reclaimed` is illegal and throws _before any batch is built_. Trigger:
`reclaimAttachmentGroup` spends a message cell without ever transitioning the
row (E10), or a second device shares the key. The same candidate is re-listed
first on every run — permanent wedge.

**E3 — `releaseReclaimedCapacity` cannot succeed in production.**
`balances.ts:87-99,119-124`. `reserveCapacity` (available→reserved) and
`markReclaimable` (reserved→reclaimable) have **zero production callers** — a
repo-wide search finds them only in `balances.ts` and in tests.
`runBalanceRefresh` writes only `total`/`available`. So on the first real
reclaim, `#move` from an unfunded `reclaimable` bucket throws
`insufficient reclaimable: have 0, need N` at `lifecycle.ts:257` — _after_ the
tx committed and rows were marked `reclaimed` — and the rerun returns `null`
(nothing left in queue), so the accounting is skipped forever and the error is
unrecoverable-but-silent. The §5.5 category ledger is effectively dead code
behind a live API. The suite is green here only because `lifecycle.test.ts:296`
funds the bucket by hand.

**E4 — RPC `unknown` conflated with `dead`.** `lifecycle.ts:196-205,300-314` vs
`client.ts:284-286`. `parseLiveCellStatus` carefully distinguishes `dead` from
`unknown` (rule 4), but both lifecycle consumers collapse to `status !== "live"`.
A transient `unknown` (lagging/restarting/pruned node) for a still-live cell
transitions its row to terminal `reclaimed` (which has no outbound transitions),
stranding that cell's capacity with no automated path back — and drives a false
`remote_reclaimed` + destructive `pruneSpentWatches` in `pollWatchesOnce`. This
is also a rule-4/rule-7 violation (irreversible state from one unverified RPC
answer). Fix: treat `unknown` as "no information"; act only on explicit `dead`.

**MEDIUM reclaim items (E5–E10).**

- **E5** `runPendingTransactions` calls `executeReclaimBatch()` _without_ the
  `reclaim:batch` lease held by `runReclaimBatch`, so the two workers can double-
  run and double-credit `available` (`markOutgoingTxState` is not compare-and-
  swap). Make it a CAS gated on the winner.
- **E6** `runPendingTransactions` marks the reclaim tx `committed` _before_ the
  resume path that requires `state === "submitted"` — the comment claims the
  opposite of what the code does; journaled capacity is never released. Reorder.
- **E7** Released-capacity accounting is gross-of-fee and double-counts against
  the next chain refresh (a ~30-min window). Fee _provisioning_ itself looks
  sound (5,262-byte placeholder witnesses size the fee; `estimatedFee <= 0`
  rejected).
- **E8** Receipt/ack processing is at-most-once: the row is set `received`
  before `processAcknowledgements` runs, and any throw is swallowed by a blanket
  `catch {}` — a dropped ack strands that message's capacity permanently
  (re-discovery dedups and skips receipts).
- **E9** Reclaim is only ever queued by a recipient's `0x01` receipt; a recipient
  who never acks pins the sender's capacity forever. There is no autonomous/aged
  reclaim path. At minimum this needs a threat-model disclosure + a manual/TTL
  reclaim.
- **E10** `reclaimAttachmentGroup` resume returns `releasedShannon:"0"`, never
  releases journaled capacity, and never transitions the message row (root cause
  of E2).

---

### S1. MEDIUM — Signer never asserts single-script-group membership

`packages/cemp-ckb/src/signing.ts:272,317`. Both stream builds hard-code
`groupInputIndices = tx.inputs.map((_,i)=>i)` — "every input is my group" — with
no assertion that `resolvedInputs[i].cellOutput.lock` equals the signer's lock.
Every _current_ builder holds this invariant by construction (they use
`completeInputsByCapacity(signer)`, which scopes to the signer's own lock, or an
explicit `scriptEquals` check), so there is no live exploit. But `signing.ts` is
a general-purpose `ccc.Signer`; the first feature that composes a mixed-lock
input set will mis-group witnesses/cells and fail closed (signature-verify
failure, not fund loss). Add an assertion `resolvedInputs[i].cellOutput.lock.eq(this.lock)`
for defense-in-depth. Verified by reading; corroborated against `@ckb-ccc/core@1.12.5`
`completeFee` behaviour.

### B. MEDIUM — Log redaction can't catch 32-byte secrets and isn't wired up

`packages/cemp-crypto/src/redact.ts:7-22`. The hex mask is ≥128 hex chars (≥64
bytes), deliberately chosen so 32-byte _public_ ids (tx hashes, profile ids)
stay visible — but the KDF chain produces multiple **32-byte secrets** (ML-DSA/
ML-KEM sub-seeds, rotated sub-seeds, `localDatabaseKey`, HKDF message keys, the
KEM shared secret) that are byte-length-indistinguishable from those public ids,
so an accidental hex dump of one would pass through unmasked. Separately,
`redactSecrets` is never invoked outside its own test — `apps/reference-client/src/main.ts`
logs straight to `console.*`. Today's code is disciplined about never
interpolating secrets into messages, so there is no live leak; this is the
defense-in-depth layer the module exists to provide, and as built it would miss
a 32-byte secret. Fix: redact by call-site tagging rather than length-sniffing,
and actually wire it into the log sink.

### V1. MEDIUM — `autoLockSeconds` is a security control in the unauthenticated `meta` block

`packages/cemp-secure-vault/src/format.ts:34,196-205,379-384`;
`vault.ts:356,763,782-786`. `meta` is documented as non-secret UI hints that
"can at worst mislabel." True for `createdAt`/`wordCount`/`hasPassphrase` (which
have authenticated copies inside the encrypted payload) — but **not** for
`autoLockSeconds`, which has no authenticated copy and drives the real auto-lock
timer, and is excluded from `payloadAad`. Evil-maid: an attacker with brief
write access sets it to ~24 days; the next normal unlock then stays unlocked for
weeks, defeating the exact lost/borrowed-device mitigation auto-lock exists for.
Fix: move it into the encrypted payload / AAD, or clamp to a hard app-side max
that ignores the file value.

### V2. MEDIUM — Native KDF bridge exposes password + KEK as unwipeable strings

`apps/android/src/platform/native-kdf.ts:58-74`;
`apps/android/.../CempKdfModule.kt:44-57,80`. The password is hex-encoded into a
JS string and the derived KEK is returned from the bridge as a 64-char hex
string — full copies of secret material as immutable strings that cross the RN
bridge (JSON-serialized; dev builds can log bridge traffic) and cannot be wiped.
Kotlin-side buffers (`ByteArray` + `StringBuilder`) are never zeroed. The noble
path never creates a string copy of the KEK, so the native path is strictly
worse than the reference the design benchmarks against, and the zeroisation prose
understates it. Fix: pass raw/Base64 bytes and overwrite on the Kotlin side;
update the zeroisation claims.

### C1. MEDIUM — Enum/discriminant bytes pass `validate*` unchecked

`packages/cemp-core/src/codec/validate.ts:229-261` (payload), `:110-141`
(profile). `body_type`, `ReceiptEntryV1.status`, `CempProfileV1.revoked`,
`supported_attachments`, and `receipt_request` are shape-decoded to the full
`0x00–0xff` range and not range-checked. Live probes: `body_type=0x55`,
`status=0xff`, `revoked=0xff` all return `{ok:true}`. Every current consumer is
fail-safe (`revoked !== 0`, `status === 0x01`, `body_type` re-bound to the enum-
checked `content_type`), so there is no type confusion today — but
`validatePayload` is documented as the standalone gate for decrypted plaintext,
and a future consumer trusting these bytes inherits an unvalidated attacker-
controlled value. Reject unknown discriminants in `validate*Fields` per spec
§12.2.

### Lower-severity items (condensed)

- **S2 (LOW/INFO).** No e2e on-chain broadcast test exercises the TS
  builders + signer + live `completeFeeBy` against a real node or `ckb-debugger`.
  The only on-chain acceptance evidence is the upstream Rust integration test's
  proof-of-life spend, not a tx assembled by `@cemp/ckb`. This is exactly the
  gap this project's own history flags repeatedly (mock chains don't validate
  scripts). Gate a `ckb-debugger --mode fast` (or real testnet) round-trip
  against the deployed binary before mainnet-value txs.
- **S3 (LOW).** `signOnlyTransaction` skips `ensurePlaceholderWitnesses`; safe
  today because `completeFeeBy` re-pads every iteration, but the API is
  asymmetric with `signTransaction`.
- **C2 (LOW).** `cemp-images` `receive.ts`/`manifest.ts` `hexToBytes` silently
  truncates odd-length input and coerces non-hex to 0, unlike the strict codec
  copy. Use the strict version everywhere RPC hex is parsed. Impact bounded by
  the `checkManifest` size gate.
- **V3 (LOW).** VEK not zeroed on the payload-auth-failure path in `unlock` /
  `unlockWithBiometrics` (inconsistent with `revealMnemonic`/`changePassword`).
- **V4 (LOW).** `biometricSlot.wrappedVek` has no upper length bound and the
  whole file is `JSON.parse`d with no size cap — the one unbounded allocation
  from a hostile local file.
- **V5 (LOW/info).** No KDF-strength _floor_ — a file recording trivially weak
  params is accepted on unlock (an attacker can't lower an existing file's params
  thanks to KEK-binding; creation always uses strong defaults).

---

## 4. Answers to the five explicit questions

**Q1 — Forgery / malleability in the v2 CighashAll stream?** No. The TS port is
byte-for-byte with the Rust host and on-chain twin: `u32-LE` (not `u64`) length
prefixes on every variable segment (no delimiter ambiguity, no unprefixed
concatenation, so distinct byte content cannot collapse to the same stream);
`tx_hash` covers the raw tx; each resolved input contributes full `CellOutput` +
length-prefixed data; the first group witness is split into `input_type`/
`output_type` BytesOpt slices with the lock excluded; remaining/extra witnesses
stream in full. Golden vectors assert byte-equality over three scenarios
including the skip-first-witness and extra-witness-beyond-inputs paths. FIPS-204
pure-mode **single-wrap** framing (`0x00 || 0x0E || "CKB-MLDSA-LOCK" || digest`)
is confirmed both structurally (noble applies the ctx wrap exactly once) and by a
byte-identical deterministic-signature vector vs the Rust `fips204` crate, plus a
hedged-signature interop test that verifies under the harness with a negative
control. Keygen parity (pubkey + secret key) holds over three seeds. Fee-
completion interaction is safe: witnesses are excluded from `tx.hash`, the lock
field being solved for is excluded from the stream, and `verifyOwnSignature`
correctly rejects any post-signing tamper of a covered field. Residual: S1
(unchecked single-group assumption) and S2 (no e2e broadcast test from the TS
path).

**Q2 — Is the rotation derivation sound, and is the on-chain back-reference +
structural chain validation sufficient for contact trust?** The _derivation_
is sound: `HKDF(baseSubSeed, nil, domain‖u32le(N))` is PRF-secure, generations
are independent, and there is no prefix-collision weakness (HMAC-based HKDF, and
rotation uses different IKM than base derivation). It provides key _lineage_, not
forward secrecy — acceptable given everything descends from one BIP39 seed. But
the structural chain validation is **not sufficient** — see Finding A. Structural
checks over a self-declared `previous_profile_id` with no tx-graph or signature
binding are forgeable; the "on-chain back-reference" is enforced only for honest
senders using CEMP's builder, never verified by the recipient.

**Q3 — Multi-slot VEK downgrade path / native-engine KDF profile-stripping?** No
downgrade path. Envelope encryption: payload encrypted once under a random VEK;
the password slot wraps it under a KDF-derived KEK at full recorded strength; the
biometric slot is an opaque hardware blob with no KDF, unusable from the file
alone. Editing recorded KDF params only guarantees unwrap failure (the KEK is
derived from those exact params, and params are additionally bound in the payload
AAD), so profile-stripping is defeated — a brute-forcer is _forced_ to run the
full recorded KDF per guess. DoS caps run before any derivation. The two things
to fix are V1 (`autoLockSeconds` outside the authenticated region) and V2 (native
bridge string copies).

**Q4 — Capacity-loss edges in reclaim?** Yes — see Findings E1–E4 (HIGH) and
E5–E10 (MEDIUM). No permanent on-chain bricking and rule-9 authority holds, but
crash/uncommitted-tx windows, an illegal-transition abort, an unfunded ledger
bucket, and `unknown`/`dead` conflation each strand capacity or wedge the
pipeline; races and gross-of-fee accounting corrupt local balances.

**Q5 — Metadata leakage beyond the threat model?** The threat-model README's
disclosures (cell creation, size, timing, funding source, reclaim timing,
repeated route-tag activity, probable relationships, attachment size ranges) are
accurate and appropriately un-overclaimed. One item to add explicitly (E9): the
receipt-gated reclaim design means **reclaim timing is recipient-controlled**,
and the absence of an autonomous reclaim both leaks "sender is waiting" and
enables capacity griefing. Also surface P2 (classical upgrade key over the PQ
lock) as a trust-root disclosure.

---

## 5. Verified-correct properties (credit where due)

- **CighashAll / FIPS-204:** byte-exact port, single-wrap framing, keygen +
  signature parity, canonical injectivity of every variable field, correct
  handling of the sibling-project witness-padding / real-input-data / no-double-
  wrap traps (`ensurePlaceholderWitnesses` re-asserted before signing;
  `getCellLive(withData=true)` avoids the CCC cache trap; `setWitnessArgsAt`
  serializes internally, no double-wrap).
- **Key derivation:** RFC-5869-correct HKDF with correct IKM/info/salt roles; no
  cross-generation leakage; sub-seeds never reused across algorithms; standard
  BIP39 (PBKDF2-HMAC-SHA512, NFKD), non-hardened BIP32 correctly avoided; sound
  CSPRNG with loud failure; errors never carry secret material; zeroisation
  handled as well as JS permits and honestly scoped.
- **Vault:** no downgrade path; KDF params authenticated via KEK-binding +
  payload AAD; safe 96-bit random nonces (few encryptions per key); strict,
  fuzzed parser; keystore biometric flag bound into AAD.
- **Molecule codec:** two-layer defense — a `guardedDynItemVec` allocation bound
  on every dynamic vector, plus a whole-tree canonical re-encode equality check
  that rejects trailing garbage / non-monotonic / overlapping offsets. A 1,773-
  case single-byte-flip sweep produced no hang, no OOM, no non-`CempCodecError`
  throw, no non-canonical accept. Schema ↔ codec ↔ protocol doc match field-for-
  field; version-first layout prevents discriminant type confusion. No redundant-
  length-prefix "unspendable cell" trap.
- **Reclaim (the good parts):** rule-9 authority end-to-end; batch atomicity;
  journal-before-broadcast _ordering_ correct everywhere; solid idempotency
  primitives (`ON CONFLICT DO NOTHING`, UNIQUE logical-message-id, purpose-
  embedded row-id replay); BigInt-over-TEXT balances with negative-refusal and
  `BEGIN IMMEDIATE` transactions.

---

## 6. Process & evidence notes

- **The suite is not green.** `pnpm build && pnpm test` → **435 passed, 3 failed,
  1 skipped (439 total)**, contradicting the request's "410 tests + 1 skipped
  green" premise. All three failures are in
  `packages/cemp-core/src/platform-boundaries.test.ts`: `REPO_ROOT =
join(__dirname, "../..")` resolves to `…/packages` (should be `../../..`), so
  every path doubles to `packages/packages/…` and the walk throws `ENOENT`. It is
  a broken _test_, not a product defect — but it means (a) the "all green"
  evidence is stale, and (b) the AGENTS.md platform-boundary guard (no `node:*` /
  `react-native` imports in shared packages) is currently **non-functional**.
  Fix the path and confirm the guard actually scans.
- **Strongest crypto guarantee is conditionally run.** The noble↔fips204 interop
  and deterministic-signature vector checks `skipIf(!harnessAvailable)` — they
  only execute when `cargo` is present. Ensure CI runs with the Rust toolchain so
  the cross-runtime byte-exactness is actually exercised, not skipped.
- **Trust root (P2).** Per the threat model, the deployed v2 ML-DSA locks are
  Type-ID-upgradeable by a secp256k1 key until the immutable mainnet deployment —
  a classically-breakable trust root sitting above the post-quantum verifiers.
  This should be closed (immutable deploy) as part of the mainnet cutover and
  called out in-product.

---

## 7. Recommended gate actions before mainnet

1. **Fix Finding A** (rotation trust) with tx-graph verification and/or a
   retiring-key signature, ideally before the rotation-discovery feature ships.
2. **Fix reclaim E1–E4** (journal signed bytes / requeue; legalise the
   `reclaim_queued` dead-cell transition; fund or remove the `reclaimable`
   ledger path; stop treating `unknown` as `dead`).
3. **Fix V1 and V2** (authenticate `autoLockSeconds`; stop transporting
   password/KEK as unwipeable strings).
4. **Re-green the suite** (P1) and run the Rust-interop tests in CI.
5. Tighten the MEDIUM latent items (S1 group assertion, B redaction wiring, C1
   discriminant checks) and add the S2 on-chain acceptance test.
6. Close the P2 trust root and add the E9/P2 metadata disclosures.

Once (1)–(4) land, a focused re-review of just those deltas should be enough to
clear the gate.
