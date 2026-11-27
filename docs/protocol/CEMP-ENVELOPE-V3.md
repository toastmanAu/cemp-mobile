# CEMP envelope, protocol version 3 (sender-signed)

- Status: Normative for builds from `security/authenticated-messaging-v2`
  onward (ADR 0007, accepted 2026-11-03). Testnet only.
- Schema: `packages/cemp-core/schemas/cemp-v3.mol`, read together with
  `cemp-v1.mol` and `cemp-v2.mol`.
- Vectors: `packages/cemp-test-vectors/vectors/cemp-v3-serialization.json`
  (Molecule round-trips) and `cemp-v3-envelope.json` (signature known answers
  and negatives).
- Conventions (byte order, hex, sizes) are those of
  [CEMP-PROTOCOL-V1.md](CEMP-PROTOCOL-V1.md) §1–§3. Everything not restated
  here is unchanged from v1/v2.

The keywords MUST, MUST NOT and SHOULD are normative.

## 1. Wire format

```text
array MlDsa65Signature [byte; 3309];

table CempEnvelopeHeaderV3 {      // the clear header: the AEAD AAD
  protocol_version: byte,         // = 3
  network: byte,                  // 0x01 ckb_testnet; 0x00 reserved (mainnet) and rejected
  expiry_hint: Uint64,
}

table CempEnvelopeV3 {            // the message-cell data
  header: CempEnvelopeHeaderV3,
  kem_ciphertext: MlKem768Ciphertext,  // 1088 bytes
  nonce: AesGcmNonce,                  // 12 bytes
  encrypted_payload: Bytes,            // AES-256-GCM(molecule(CempInnerV3)) || 16-byte tag
}

table CempInnerV3 {               // the AES-GCM plaintext
  sender_profile_id: Byte32,
  conversation_id: Byte32,        // = H(sorted(sender_profile_id, recipient_profile_id))
  content_type: byte,             // 0x01 text, 0x03 attachment manifest
  created_at_client: Uint64,
  payload: CempPayloadV2,         // unchanged (cemp-v2.mol): message_id, recipient_profile_id,
                                  // text, manifests, reply fields, ReceiptEntryV2 receipts, padding
  sig_algorithm: AlgorithmIdV1,   // MUST be {0x01, 61} (ML-DSA-65)
  signature: MlDsa65Signature,
}

table CempSigningTranscriptV3 {   // never on the wire; rebuilt by both sides
  header: CempEnvelopeHeaderV3,   // the exact clear header (canonical Molecule)
  kem_ciphertext: MlKem768Ciphertext,
  nonce: AesGcmNonce,
  sender_profile_id: Byte32,
  conversation_id: Byte32,
  content_type: byte,
  created_at_client: Uint64,
  payload: CempPayloadV2,
}
```

The header is 26 bytes. `message_id`, `conversation_id`, `sender_profile_id`,
`content_type`, `created_at_client` and `reply_to_message_id` are NOT in clear
text in v3. The message-cell type args are unchanged (version byte `0x01`,
route tag, conversation tag, nonce; CEMP-PROTOCOL-V1 §6).

## 2. Version dispatch

Field 0 of every envelope is the header table, and field 0 of every header is
`protocol_version`. A receiver MUST read that byte through the Molecule offset
tables, then strict-decode the whole envelope with exactly one schema:

| `protocol_version` | Envelope         | Plaintext       |
| ------------------ | ---------------- | --------------- |
| 1                  | `CempEnvelopeV1` | `CempPayloadV1` |
| 2                  | `CempEnvelopeV1` | `CempPayloadV2` |
| 3                  | `CempEnvelopeV3` | `CempInnerV3`   |

Any other value MUST be rejected. A layout that does not match its declared
version MUST be rejected, never re-tried as another layout. Strict decoding is
the v1 rule: exact fixed sizes, no trailing bytes, canonical offsets only.

## 3. Keys and encryption

```text
(kem_ct, ss) = ML-KEM-768.Encapsulate(recipient.ml_kem_public_key)
PRK          = HKDF-Extract(salt = nonce, IKM = ss)                 // SHA-256
message_key    = HKDF-Expand(PRK, "CEMP-MESSAGE-KEY-V3"    ‖ recipient_profile_id, 32)
attachment_key = HKDF-Expand(PRK, "CEMP-ATTACHMENT-KEY-V3" ‖ recipient_profile_id, 32)
receipt_key    = HKDF-Expand(PRK, "CEMP-RECEIPT-KEY-V3"    ‖ recipient_profile_id, 32)
encrypted_payload = AES-256-GCM(message_key, nonce, molecule(CempInnerV3),
                                AAD = molecule(CempEnvelopeHeaderV3))
```

Unlike v1/v2, the Expand info has no sender id: a receiver cannot know the
sender before decryption. The sender is bound by the signature (§4), which
covers `kem_ciphertext` and `recipient_profile_id`. The `-V3` domain strings
keep v3 keys separate from all v1/v2 keys. Receipt proofs are computed as in
ADR 0006 (`HMAC-SHA256(receipt_key, "CEMP-RECEIPT-PROOF-V1" ‖ message_id ‖
status)`), with the v3 `receipt_key`.

`nonce` and the KEM encapsulation randomness MUST be fresh per envelope. The
image path pre-derives `attachment_key` from a fixed encapsulation message and
then seals the envelope around that same encapsulation (CEMP-PROTOCOL-V1 §6
coordination).

## 4. Signature

```text
signature = ML-DSA-65.Sign(sender.ml_dsa_secret_key,
                           M   = molecule(CempSigningTranscriptV3),
                           ctx = "CEMP-ENVELOPE-V3")      // FIPS 204 pure mode, no prehash
```

- The signer is the sender's ACTIVE profile key: the key its profile cell
  publishes as `ml_dsa_public_key`, whose ML-DSA lock holds that profile cell.
- Senders SHOULD sign hedged (randomized). Vectors use `rnd = 0x00*32`.
- The same key signs CKB transactions with ctx `"CKB-MLDSA-LOCK"` over a
  32-byte digest. FIPS 204 puts the context inside M′, so neither signature
  verifies as the other. The vectors include both replay directions.
- A sender MUST verify its own signature against the published public key
  before sending.

## 5. Receive pipeline

A receiver MUST process a v3 envelope in this order and stop at the first
failure:

1. Pre-decryption budget (§7).
2. `validateEnvelope`: size ≤ 82,000 bytes, version dispatch (§2), network
   byte, GCM tag length. Key-free.
3. ML-KEM decapsulation and AES-GCM open with AAD = header bytes.
4. Strict decode of `CempInnerV3` (≤ 65,536 + 4,096 bytes), then:
   `sig_algorithm == {0x01, 61}`; `content_type` is known and equals
   `payload.body_type`; the payload passes the v2 payload limits;
   `payload.recipient_profile_id == own profile id`;
   `conversation_id == H(sender_profile_id, own profile id)`.
5. Resolve the sender's key and verify the signature over the rebuilt
   transcript (§6).
6. Only now: block list, per-sender rate limit, contact upsert, store,
   notify, all keyed on the AUTHENTICATED sender.
7. Receipts (ADR 0006 acceptance, sender now authenticated), then the
   auto-ack.

Steps 1–5 are identical for chain and LoRa delivery: the proof travels inside
the envelope.

## 6. Sender key resolution

Verdicts (`AuthenticatedSenderResolver`, `packages/cemp-ckb`):

| Case                                                                                                                                                                                                                                             | Verdict                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| A contact with this profile id has a pinned key, and the signature verifies under it                                                                                                                                                             | `trusted`                                                      |
| Pinned key fails; the live profile has the pinned key (forgery), or the signature verifies under neither key                                                                                                                                     | `rejected`                                                     |
| Pinned key fails; the same profile id now publishes another key and the signature verifies under it (no provable rotation: rotations mint a new profile id)                                                                                      | `key-changed-blocking`                                         |
| No pinned key: exactly one live profile cell for the id; `lock_script_hash` binds its lock; the lock is the network ML-DSA lock with args `== mldsaV2LockArgs(ml_dsa_public_key)`; not revoked; the signature verifies under `ml_dsa_public_key` | `unknown-signed` (pin the key)                                 |
| …and the live profile's `previous_profile_id` names a pinned contact: its creating tx consumed a Type-ID cell with that id, locked by the PINNED key's ML-DSA lock, and `previous_profile_id` names it                                           | `rotation-verified` (re-pin), otherwise `key-changed-blocking` |
| Any RPC/indexer failure, or no live profile cell yet                                                                                                                                                                                             | `deferred`                                                     |
| Anything else (bad signature, unbound or revoked profile, duplicate cells)                                                                                                                                                                       | `rejected`                                                     |

- `rejected`: no row, notification, ack or contact. Terminal for that cell.
- `deferred`: the cell stays undisposed and is retried with exponential
  backoff (1 min, doubling, capped at 6 h). Never shown or acked. An RPC
  failure MUST NOT be turned into either a negative or a positive verdict.
- `key-changed-blocking`: a blocking "key changed" card in the known
  contact's conversation. The body is never stored, shown or acked.
- Display names are never a trust input. An `unknown-signed` sender gets an
  `unknown-xxxx` contact and never takes over another contact's name or
  conversation.
- Each incoming row stores `ckbHash(verifying key)` (`sender_key_hash_hex`).
- Rotation proof is single-hop. A longer chain is not provable by this
  resolver and blocks.

## 7. Pre-decryption rate limits

Before any decapsulation, each sync tick charges one unit to a global budget
(default 200 cells per tick) and one to the cell's funding source (default 20
per tick). For chain delivery the funding source is the lock hash of the first
input of the transaction that created the cell; for LoRa it is the gateway. A
cell over budget is left untouched for the next tick. A funding-lock lookup
failure defers the cell. Cells already ingested are re-run (for their
receipts) without being charged. The persisted per-sender limiter runs only
after verification, on the authenticated sender.

## 8. Send path

- Every send — content, receipt-only ack, and content with receipts — is v3.
  There is no v1/v2 send path.
- The sender signs before building the CKB transaction, then journals the
  signed envelope bytes (plus route tag, conversation tag, message nonce and
  message id) and the receipt key before building. A crash or retry
  rebroadcasts identical bytes. Exception: an image retry whose chunks were
  re-published under a new encapsulation MUST re-seal (the journaled envelope
  was never broadcast and names chunks under another key).

## 9. Legacy (v1/v2) after the upgrade

- v1/v2 content is stored only in an EXISTING contact's conversation, labelled
  "Unverified (legacy)". It is never notified as the contact's message, never
  auto-acked, and never creates a contact. All legacy content shares one
  per-sender rate bucket.
- v2 receipts with valid ADR 0006 proofs are still applied.
- `ACCEPT_LEGACY_UNVERIFIED_CONTENT` (`packages/cemp-core/src/protocol.ts`)
  turns off legacy content acceptance in one line once all devices send v3.

## 10. Sizes and capacity (measured)

Measured on the TypeScript implementation (random padding 0–255 bytes, max of
40 seals). The message cell locks 8 (capacity) + 70 (ML-DSA lock) + 114
(message type) + data bytes, plus a 1 CKB builder margin.

| Envelope                         | v2 bytes | v3 bytes | Δ     | v3 cell (CKB) |
| -------------------------------- | -------- | -------- | ----- | ------------- |
| text `hello`                     | 1,679    | 4,974    | 3,295 | ~5,167        |
| text, 16,384 B maximum           | 18,050   | 21,359   | 3,309 | ~21,552       |
| image manifest, 32 KiB thumbnail | 36,311   | 39,618   | 3,307 | ~39,811       |
| receipt-only ack (1 receipt)     | 1,743    | 5,043    | 3,300 | ~5,236        |

About +3,300 CKB is locked per message cell until reclaim. Image chunk cells
are unchanged: the signed manifest carries `cipher_hash`.
`CONSERVATIVE_MESSAGE_CELL_SHANNON` (the image pre-send bound) is 40,960 CKB.
A maximum-size envelope stays under the 82,000-byte envelope limit. Testnet
pool acceptance of a maximum v3 text and image envelope has NOT been measured
yet (no broadcast was made).

## 11. Not provided

Forward secrecy; deniability (the recipient holds a signature it can show to
others); hiding the sender's wallet (funding inputs) or the recipient (route
tag) from chain observers; proof that a human read a message.
