# ADR 0007: sender-signed envelopes (protocol version 3)

- Status: Accepted (2026-11-03). Decisions on the former open questions are
  at the end.
- Supersedes nothing. Builds on ADR 0006 (receipt proofs), which stays.
- Handoff reference: `CellSend_Security_Hardening_Agent_Handoff.md` Phases B–D.
  The handoff calls this "v2"; v2 is taken by ADR 0006, so this is v3.

## Context

- **AUTH-01/02 are open.** Phase A (`docs/review/PHASE-A-REPRODUCTION.md`)
  showed that anyone can encrypt to Bob with Bob's public ML-KEM key, write
  Alice's `sender_profile_id` into the header, and Bob's app files the message
  under Alice's conversation. AES-GCM success proves only that the sender knew
  Bob's PUBLIC key.
- **The chain does not help.** The transaction's ML-DSA lock signature proves
  who spent the inputs, not which identity the message claims. LoRa delivery
  has no transaction at all.
- **Where the claimed sender is trusted today** (`packages/cemp-sync/src/workers.ts`
  ~L310–335): the block list, the per-sender rate limiter, contact lookup, and
  auto-creation of an `unknown-xxxx` contact all key on the unauthenticated
  header field.
- **What already exists and is reused:**
  - every profile cell carries `ml_dsa_public_key` (CempProfileV1), and the
    same key controls the profile's ML-DSA lock;
  - `resolveLiveProfile` + `checkResolvedProfileBinding` (`packages/cemp-ckb/src/profiles.ts`)
    fetch a profile by Type ID and check `lock_script_hash` against the cell's
    real lock;
  - `verifyRotationLinkOnChain` / `verifyRotationChainOnChain` prove a rotation
    was authorized by the retiring key (the successor's creating tx consumed
    the predecessor cell);
  - the `contacts` table already stores a pinned `ml_dsa_public_key`,
    `fingerprint` and `trust_verdict` (migration at `migrate.ts` ~L185).
- **Size.** An ML-DSA-65 signature is 3,309 bytes. One per message cell is
  about +3.3 KB of occupied capacity, which is about +3,300 CKB locked per
  message until reclaim.

## Decision

### 1. Sign, then encrypt; the signature travels inside the ciphertext

The sender signs a transcript (section 3) and puts the signature INSIDE the
AES-GCM plaintext, next to the payload. Nothing identifying the sender is
left in clear text.

Why inside rather than an outer signature on the cell:

- **An outer signature is a public, verifiable sender label.** Anyone could
  try it against every published profile key and learn who sent each message.
  It would also be a transferable proof to third parties that Alice sent
  this ciphertext to Bob. Inside the ciphertext, only the recipient can see or
  check it.
- **Same cell size either way.** The cost is the 3,309 bytes, wherever they sit.
- **Cost of verifying after decryption is small.** ML-KEM decapsulation plus
  AES-GCM runs before signature verification. Both are cheap compared with
  the ML-DSA verify, and an attacker who can create cells can already make the
  recipient decapsulate today.
- **Honest limit:** this does not hide the sender from the chain. The cell is
  usually funded from the sender's own ML-DSA lock, so the inputs still reveal
  the wallet. Hiding sender metadata on chain is out of scope.

### 2. Clear header shrinks to what a pre-decryption reader needs

```text
table CempEnvelopeHeaderV3 {
  protocol_version: byte,      // = 3
  network: byte,
  expiry_hint: Uint64,
}
table CempEnvelopeV3 {
  header: CempEnvelopeHeaderV3,
  kem_ciphertext: MlKem768Ciphertext,
  nonce: AesGcmNonce,
  encrypted_payload: Bytes,     // AES-256-GCM(CempInnerV3) || tag; AAD = header bytes
}
```

`message_id`, `conversation_id`, `sender_profile_id`, `content_type`,
`created_at_client` and `reply_to_message_id` move inside. That removes the
public data ADR 0006's forger relied on, and the clear `conversation_id` that
identified the recipient (the route tag still does; see Consequences).

**Implementation check before freezing:** confirm nothing reads those header
fields before decryption (discovery dedup, reclaim, LoRa gateway). Any such
reader moves to the outpoint or to its own database row.

### 3. Inner plaintext and signing transcript

```text
array MlDsa65Signature [byte; 3309];

table CempInnerV3 {
  sender_profile_id: Byte32,
  conversation_id: Byte32,
  content_type: byte,
  created_at_client: Uint64,
  payload: CempPayloadV2,        // unchanged: message_id, recipient_profile_id,
                                 // reply fields, ReceiptEntryV2 receipts, padding
  sig_algorithm: AlgorithmIdV1,  // must be {0x01, 61} (ML-DSA-65)
  signature: MlDsa65Signature,
}

table CempSigningTranscriptV3 {  // never on the wire; rebuilt by both sides
  header: CempEnvelopeHeaderV3,  // exact clear header bytes
  kem_ciphertext: MlKem768Ciphertext,
  nonce: AesGcmNonce,
  sender_profile_id: Byte32,
  conversation_id: Byte32,
  content_type: byte,
  created_at_client: Uint64,
  payload: CempPayloadV2,
}

signature = ML-DSA-65.Sign(sk, molecule(CempSigningTranscriptV3),
                           ctx = "CEMP-ENVELOPE-V3")      // FIPS 204 pure mode
```

- **Every semantic field is under the signature**, serialized as Molecule
  (length-framed, canonical; the strict codec rejects non-canonical input).
- **Forwarding is blocked.** The transcript includes the `kem_ciphertext`, and
  the payload includes `recipient_profile_id`. Bob cannot re-encrypt Alice's
  signed content to Carol: a new encapsulation changes the transcript. A
  receiver checks that `recipient_profile_id` is its own.
- **No separate prehash.** The handoff suggested signing
  SHA-256(domain || bytes). Pure ML-DSA already hashes the message together
  with H(public key) and the context, so the extra layer adds nothing.
  Transcripts are a few KB, which is fine.
- **Separation from transaction signing.** The same key signs CKB transactions
  with ctx `"CKB-MLDSA-LOCK"` over a 32-byte digest (`mldsa-v2.ts`). FIPS 204
  puts the context inside the signed message M', so an envelope signature can
  never verify as a lock witness, or the reverse. New functions
  `signEnvelopeV3` / `verifyEnvelopeV3` live beside `mldsaV2Sign` and do not
  touch it.
- **Signing mode:** hedged (randomized) signing in production. The vectors
  use `extraEntropy = 0x00*32` for byte-exact known answers, the same
  convention as the existing lock vectors.

### 4. Version dispatch

Envelope field 0 is the header table, and header field 0 is
`protocol_version` in v1, v2 and v3 alike. The decoder reads that byte through
the offset tables, then strict-parses with exactly one schema: 1 → V1/PayloadV1,
2 → V1/PayloadV2, 3 → V3. There is no fallback between layouts, and any other
value is rejected.

### 5. Who is the sender? (key resolution)

Verification happens in a new `AuthenticatedSenderResolver` (`packages/cemp-ckb`).
It returns a verdict, never a bare boolean:

| Case                                                              | Key used                                                                                                                                                  | Result                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Known contact, pinned key                                         | `contacts.ml_dsa_public_key`                                                                                                                              | valid → `trusted`                                                                          |
| Known contact, pinned key fails, live profile has a different key | live key, only if `verifyRotationChainOnChain` links pinned → live                                                                                        | valid → `rotation-verified`, re-pin; otherwise `key-changed-blocking`, message quarantined |
| Unknown sender                                                    | live profile by the claimed id; `checkResolvedProfileBinding` passes; the lock is the ML-DSA lock and its args equal `mldsaV2LockArgs(ml_dsa_public_key)` | valid → `unknown-signed` (new contact, key pinned)                                         |
| Signature invalid                                                 | n/a                                                                                                                                                       | rejected: no row, notification, ack or contact                                             |
| Profile fetch fails (RPC/indexer)                                 | n/a                                                                                                                                                       | `deferred`: cell left undisposed, bounded backoff retry; never displayed or acked          |

- **Display names are never a trust input.** An `unknown-signed` sender never
  takes over an existing contact's name or conversation.
- **Verified key recorded per message.** Each incoming row stores the hash of
  the verifying key, so history stays explainable after a later rotation.
- **Lock-args check matters.** Without it, a profile could advertise a key
  that does not control its own lock.

### 6. Receive pipeline order

```text
decode clear header (strict) → network check → decapsulate → AES-GCM open (AAD = header)
→ strict-decode CempInnerV3 → recipient_profile_id == me → resolve key (section 5)
→ verify signature → THEN block list / rate limit / contact / insert / notify
→ receipts (ADR 0006 rules, with the sender now authenticated) → auto-ack
```

- **The block list and rate limiter key on the AUTHENTICATED sender.** A
  pre-decryption limit keyed on the funding lock and outpoint bounds work
  before verification (see open question 3).
- **The type system enforces the order.** `processAcknowledgements` and
  contact upsert take an `AuthenticatedIncoming` branded type that only the
  verifier constructs, so unverified input cannot reach them by accident.
- **LoRa uses the same function**, because the proof is inside the envelope.

### 7. Send path

The publisher builds and signs the transcript BEFORE building the CKB
transaction. It then journals the signed envelope bytes, so a crash or retry
rebroadcasts identical bytes rather than producing a different signature for
the same logical message. The signing key is the active local profile's ML-DSA
key, never a caller-supplied identity. All sends become v3, with no fallback
to v1 or v2.

### 8. Legacy and migration (testnet flag day)

- Historical v1/v2 rows stay as they are, labelled **Unverified (legacy)** in
  the UI.
- A v1/v2 cell received after the upgrade is shown with the same label. It is
  never notified as a contact's message and never auto-acked.
- v2 receipts with valid ADR 0006 proofs are still accepted. The proof
  authenticates them independently, so outgoing v2 messages sent before the
  upgrade can still be reclaimed.
- Once all devices update, new builds stop accepting v1/v2 content behind a
  constant, so the change is one line.

## Consequences

- **Fixes AUTH-01/02/03.** A forged content message no longer appears as a
  known contact. Combined with ADR 0006, the AUTH-01…07 and RCPT rows of the
  handoff matrix become testable.
- **Cost:** about +3.3 KB per message cell, so about +3,300 CKB locked per
  message until reclaim. Image chunk cells are unchanged: the manifest
  (with `cipher_hash`) is inside the signed payload, so chunks are covered
  without signing each one. Fee estimates, the capacity check before send, the
  balance UI and the padding buckets all need updating.
- **Privacy:** sender id, conversation id and message id leave the clear
  header. The route tag still reveals the recipient to anyone who computes
  tags for known profiles, and funding inputs still reveal the sender's wallet.
- **Not provided:** forward secrecy, deniability (the recipient holds a
  signature it can show to others), and proof that a human read the message.
- **Performance:** ML-DSA-65 verify is around 1 ms in Hermes-class JS (to be
  measured on the XR, the slowest test device). It runs once per message.

## Test plan (before send/receive defaults change)

- **Vectors:**
  - deterministic sign known answers for text, image and receipt-only
    envelopes;
  - every negative case: wrong key, each transcript field mutated, wrong
    context, `"CKB-MLDSA-LOCK"` context replay, wrong `sig_algorithm`, short
    or long signature, `recipient_profile_id` ≠ me, `kem_ciphertext` swap
    (forwarding).
- **Cross-runtime:** the Rust `ml-dsa` crate (already a contract dependency)
  verifies the TS vectors.
- **Resolver:**
  - pinned key accepts;
  - a forged rotation (no predecessor consumed) is blocked;
  - an honest rotation with the predecessor spent is accepted;
  - a profile key that does not match its lock args is refused;
  - an RPC failure defers and never downgrades.
- **Phase A flips:** AUTH-01/02 and TRNS-01 content go from reproduced to
  FIXED, each with a mutation check (bypass verification and the named test
  goes red).
- **Testnet:** a maximum-size v3 text envelope and an image envelope are
  accepted by the pool. Measured capacity and fee are recorded in the spec.

## Resolved questions (accepted 2026-11-03)

1. **Receipt-only acks are signed too.** One envelope shape and one gate; the
   extra capacity is returned on reclaim.
2. **`content_type` is inside the ciphertext**, as drafted.
3. **Pre-decryption rate limit:** a global per-sync budget plus a budget per
   funding lock hash (the lock of the cell's first input, or the gateway
   source for LoRa). The per-sender limit runs after verification.
4. **Pinned-key mismatch without a provable rotation:** show the blocking
   "key changed" card (`key-changed-blocking`); the message body is never
   shown or acked.

## Implementation notes (2026-11-03)

Commits on `security/authenticated-messaging-v2`: `3a1dff0` (schema, codecs,
signing, vectors), `eb7a7a5` (resolver, AuthenticatedIncoming), `31a08c9`
(receive pipeline, schema v11), `bc77b00` (send path), `dcf8a0c` (UI), then
the Phase A flips and these notes. Normative spec:
[`docs/protocol/CEMP-ENVELOPE-V3.md`](../protocol/CEMP-ENVELOPE-V3.md).

- **Implementation check (section 2).** Nothing read the moved header fields
  before decryption: LoRa runs only the key-free `validateEnvelope`,
  discovery dedups on outpoint leases and the logical message id after
  decryption, and reclaim uses stored chain refs.
- **Decision the ADR did not state: the v3 key schedule.** v1/v2 put
  `sender_id ‖ recipient_id` into the HKDF Expand info, but a v3 receiver
  cannot know the sender before decryption. v3 uses
  `"CEMP-{MESSAGE,ATTACHMENT,RECEIPT}-KEY-V3" ‖ recipient_id`. The sender is
  bound by the signature over `kem_ciphertext` and `recipient_profile_id`.
  This changes no Molecule layout; it is pinned by the vectors.
- **Conservative additions.** `conversation_id` must equal
  `H(sender, me)` (it was unchecked in v1/v2, RCPT-04). A revoked profile is
  rejected. "No live profile cell" defers instead of rejecting, because it
  may be indexer lag. An in-place key change under the same profile id is
  `key-changed-blocking`, since rotations always mint a new profile id. Rotation
  proof is single-hop; a longer chain blocks. Legacy content from a claimed
  sender who is not already a contact is dropped (an unverified claim never
  creates a contact). All legacy content shares one rate bucket.
- **Rotation proof without a stored predecessor outpoint.** Contacts do not
  store the predecessor cell's outpoint, so the resolver searches the
  successor's creating transaction for an input that spent a Type-ID cell
  with the predecessor id, and requires that cell's lock to be the PINNED
  key's ML-DSA lock. It then runs the existing `checkRotationLink`
  (extracted from `verifyRotationLinkOnChain`).
- **Brand.** `AuthenticatedIncoming` has a compile-time `unique symbol` brand
  and a module-private `WeakSet` registry. Minted objects are frozen, but
  their `Uint8Array` fields can still be mutated in place (JavaScript cannot
  freeze typed-array contents).
- **Cross-runtime oracle.** `tools/signing-harness envelope-v3` (Rust
  `fips204` 0.4.6, the crate the harness already uses) verifies every
  signature case, re-signs every known answer byte-identically from the
  32-byte seed, and rebuilds each accepted envelope's transcript with its own
  Molecule table code. The RustCrypto `ml-dsa` crate used by the deployed
  lock was NOT used as the oracle. Run by
  `packages/cemp-crypto/src/envelope-v3.interop.test.ts`.
- **Capacity.** About +3,300 bytes per message cell, measured (spec §10).
  `CONSERVATIVE_MESSAGE_CELL_SHANNON` rose from 36,864 to 40,960 CKB: the
  largest v3 manifest cell (~39,917 CKB) would otherwise have passed the image
  pre-send check and then failed mid-build. Padding is uniform 0–255 bytes;
  there were no padding buckets to update, and the balance UI shows no
  per-message estimate.
- **Still open.** Testnet pool acceptance of a maximum v3 text and image
  envelope (test plan item) was not run: no broadcasts were made. ML-DSA
  verify timing on the XR is not measured.
