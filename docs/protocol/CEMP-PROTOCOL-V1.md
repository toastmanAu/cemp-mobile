# CEMP Protocol — Version 1

Status: Draft (Phase 1). This document is the byte-level authority for every CEMP
wire structure. Changes require updating this spec, the golden vectors in
`packages/cemp-test-vectors`, and the migration/serialization version together
(AGENTS.md rule 1).

Product behaviour, message lifecycle, and rationale live in `ckd.txt`; the v2
ML-DSA lock construction is in `docs/grounding/mldsa-v2-signing-pipeline.md`.
This document defines **bytes**, not UX.

## 1. Conventions

- All integers are **unsigned little-endian** unless stated otherwise.
- `u8`, `u32`, `u64` denote fixed widths. `len(x)` is a byte count.
- Serialization format: **Molecule** (the CKB-native format). Schema:
  `packages/cemp-core/schemas/cemp-v1.mol`. Hand-written offset code is
  forbidden; codecs are generated or centrally tested against this schema.
- Hex strings in this document are lowercase without `0x` unless quoted as CKB
  RPC values.
- Hashes: `blake2b-256` (CKB-compatible) unless a different personalisation is
  named. `H(x)` = blake2b-256 with no personalisation.
- All protocol objects are versioned (AGENTS.md rule 13): every top-level
  structure begins with `protocol_version` and identifies its algorithms.

## 2. Identifiers and sizes

| Name                    | Size (bytes) | Derivation                                                                                                   |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `profile_id`            | 32           | Type ID args of the user's Profile Cell (spec §5.3)                                                          |
| `message_id`            | 16           | OS CSPRNG, per logical message (idempotency key, spec §7.7)                                                  |
| `conversation_id`       | 32           | `H("CEMP-CONVERSATION-V1" ‖ sort(profile_id_A, profile_id_B))` (spec §6.3)                                   |
| `route_tag`             | 32           | `H("CEMP-ROUTE-V1" ‖ recipient_profile_id ‖ u64le(routing_epoch))` (spec §6.1)                               |
| `conversation_tag`      | 16           | First 16 bytes of `conversation_id`                                                                          |
| `message_nonce`         | 16           | OS CSPRNG, per published cell (distinct from `message_id` so retries of one logical message get fresh cells) |
| `device_id`             | 16           | OS CSPRNG, per installation, stored locally                                                                  |
| `reclaim_group_id`      | 16           | OS CSPRNG                                                                                                    |
| ML-DSA-65 public key    | 1952         | FIPS 204                                                                                                     |
| ML-DSA-65 signature     | 3309         | FIPS 204                                                                                                     |
| ML-KEM-768 public key   | 1184         | FIPS 203                                                                                                     |
| ML-KEM-768 ciphertext   | 1088         | FIPS 203                                                                                                     |
| AES-256-GCM nonce / tag | 12 / 16      |                                                                                                              |

`routing_epoch = floor(unix_time_seconds / 2592000)` (30-day windows).
Recipients watch the current and previous epoch's route tags (§12.4).

## 3. Algorithm identifiers

Every serialized object carrying key material or ciphertext identifies its
algorithms by `(family, parameter)` bytes:

| family | name   | parameter | name                                    |
| ------ | ------ | --------- | --------------------------------------- |
| 0x01   | ML-DSA | 61        | ML-DSA-65 (matches the v2 lock ParamId) |
| 0x02   | ML-KEM | 3         | ML-KEM-768                              |
| 0x03   | AEAD   | 1         | AES-256-GCM                             |
| 0x04   | KDF    | 1         | HKDF-SHA-256                            |

Unknown family or parameter ⇒ reject (§12 malformed input). Do not assume these
remain the only choices (spec §14.4).

Version-1 KDF and hash domain strings (spec §5.1, §14.1–14.2) — normative set:

```text
Sub-seed derivation (HKDF-SHA-256, info):
  CEMP/CKB/ML-DSA/identity/v1
  CEMP/CKB/ML-KEM/messaging/v1
  CEMP/LOCAL/database/v1
  CEMP/CONTACT/exchange/v1
  CEMP/BACKUP/encryption/v1
Message key (HKDF-SHA-256):
  PRK = HKDF-Extract(salt = envelope nonce, IKM = ml_kem_shared_secret)
  key = HKDF-Expand(PRK, "CEMP-MESSAGE-KEY-V1" ‖ sender_profile_id ‖ recipient_profile_id, 32)
Hash domains: CEMP-ROUTE-V1, CEMP-CONVERSATION-V1 (prefix-fed blake2b-256)
Lock pipeline (external, see grounding): personalisations ckb-mldsa-sct,
  ckb-mldsa-msg; FIPS-204 context "CKB-MLDSA-LOCK"
```

## 4. Identity and keys

- Recovery container: standard **BIP39** mnemonic, 12 or 24 English words,
  optional passphrase (spec §5.1). Non-hardened BIP32 derivation MUST NOT be
  used for post-quantum keys.
- `bip39_seed → HKDF-SHA-256 sub-seeds` using the domain strings of §3.
  ML-DSA and ML-KEM sub-seeds are independent (spec §5.2).
- ML-DSA-65 keypair: deterministic FIPS-204 keygen from the 32-byte identity
  sub-seed (matches fips204 `keygen_from_seed`; cross-runtime vector required).
- ML-KEM-768 keypair: deterministic FIPS-203 keygen from the 32-byte messaging
  sub-seed expanded to the FIPS-203 64-byte keygen seed via
  `HKDF-SHA-256(sub_seed, salt=nil, "CEMP/CKB/ML-KEM/messaging/v1/keygen", 64)`.
- Identity anchor: the **Profile Cell Type ID** (`profile_id`), not a display
  name (spec §5.3).

## 5. Profile Cell

- **Lock:** the owner's ML-DSA-65 v2 lock (37-byte args).
- **Type:** a Type ID script; its args are the `profile_id`.
- **Data:** `CempProfileV1` (Molecule table, see §13):

```text
CempProfileV1
  protocol_version            u8       = 1
  sig_algorithm               (0x01, 61)
  kem_algorithm               (0x02, 3)
  ml_dsa_public_key           [u8; 1952]
  ml_kem_public_key           [u8; 1184]
  lock_script_hash            [u8; 32]   // hash of the owner's messaging lock script
  supported_protocol_versions Vec<u8>  // 1..=8 entries, MUST contain 1
  supported_attachments       u8       // bitmask: 0x01 image/webp, 0x02 image/jpeg
  handle                      Option<Bytes>   // ≤ 64 bytes UTF-8; NOT unique, NOT identity
  icon_hash                   Option<[u8; 32]>// content hash of a local icon; never auto-applied (spec §10.2)
  key_created_at              u64      // unix seconds
  rotation_sequence           u32      // 0 for the initial profile
  previous_profile_id         Option<[u8; 32]> // set when rotated (spec §5.3)
  revoked                     u8       // 0x00 active, 0x01 revoked
```

- Sensitive contact information MUST NOT appear in the profile (spec §5.3).
- Profile cells are discoverable by Type ID query (spec §5.5/§10); rotation
  chains are validated by following `previous_profile_id` and checking
  signatures continuity during contact trust evaluation (spec §10.3).

## 6. Message Cell

- **Lock:** the **sender's** ML-DSA-65 v2 lock — the sender retains spending
  and reclaim authority (spec §6.1, AGENTS.md rule 9).
- **Type args (81 bytes, fixed):**

```text
version            u8         = 1
route_tag          [u8; 32]   // recipient's route tag for the current routing_epoch
conversation_tag   [u8; 16]
message_nonce      [u8; 16]
```

The type script itself is initially the network's indexing-type convention
(ADR 0003 deployment `cempMessageType: null`); the args layout above is the
discovery contract. A dedicated CEMP type script may later enforce it on-chain
(`contracts/cemp-message-type`) without changing this layout.

- **Data:** `CempEnvelopeV1` (§7).

## 7. Envelope and AEAD

```text
CempEnvelopeV1
  header              CempEnvelopeHeaderV1
  kem_ciphertext      [u8; 1088]   // ML-KEM-768 encapsulation to recipient
  nonce               [u8; 12]     // random, also the HKDF salt (§3)
  encrypted_payload   Bytes        // AES-256-GCM ciphertext ‖ 16-byte tag

CempEnvelopeHeaderV1
  protocol_version    u8 = 1
  network             u8         // 0x01 = ckb_testnet; 0x00 reserved (mainnet)
  content_type        u8         // 0x01 text, 0x02 receipt, 0x03 attachment_manifest
  message_id          [u8; 16]
  conversation_id     [u8; 32]
  sender_profile_id   [u8; 32]
  created_at_client   u64        // unix seconds
  reply_to_message_id Option<[u8; 16]>
  expiry_hint         u64        // unix seconds; 0 = none. Local policy hint only —
                                 // never proof of receipt (spec §7.5)
```

- **AAD** for AES-256-GCM is exactly `molecule(CempEnvelopeHeaderV1)`.
  Both sides reconstruct it deterministically; it binds protocol version,
  network, content type, message/conversation ids, sender, and reply linkage
  (spec §6.2). The CKB output identity is unknowable at encryption time and
  is not bound in v1.
- **Payload key:** §3 message-key HKDF over the ML-KEM-768 shared secret.
- **Nonce reuse:** the nonce is random per envelope and also salts the HKDF;
  the derived key is unique per envelope even for identical plaintexts.
- The recipient identity is **inside** the encrypted payload (§8), not in the
  header — fields that need not be public are encrypted (spec §6.1). The clear
  `sender_profile_id` reveals no more than the sender lock already does.

## 8. Encrypted payload

```text
CempPayloadV1  (plaintext of encrypted_payload, Molecule)
  message_id            [u8; 16]        // MUST equal header.message_id
  body_type             u8              // mirrors header.content_type
  recipient_profile_id  [u8; 32]        // recipient MUST verify equality with own id
  text                  Option<Bytes>   // UTF-8, ≤ 16384 bytes; required when body_type=0x01
  attachment_manifests  Vec<AttachmentManifestV1>  // ≤ 4 entries (Phase 10)
  reply_to_message_id   Option<[u8; 16]>
  reply_to_outpoint     Option<OutPointV1>
  receipts              Vec<ReceiptEntryV1>        // ≤ 64 piggybacked receipts (§9)
  receipt_request       u8              // bitmask 0x01 delivered, 0x02 read (read receipts opt-in, spec §8)
  client_timestamp      u64
  sender_device_id      [u8; 16]
  padding               Bytes           // 0–255 random bytes (size obfuscation, spec §15)

OutPointV1
  tx_hash   [u8; 32]
  index     u32

AttachmentManifestV1  (Phase 10; defined now for schema stability)
  attachment_id         [u8; 16]
  ckbfs_root            OutPointV1
  chunk_outpoints       Vec<OutPointV1>
  encrypted_size        u64
  plaintext_size        u64
  mime_type             Bytes        // ≤ 64 bytes
  width                 u32
  height                u32
  thumbnail             Option<Bytes>
  content_hash          [u8; 32]     // plaintext hash
  cipher_hash           [u8; 32]     // ciphertext hash
  encryption_nonce      [u8; 12]
  encryption_algorithm  (0x03, 1)    // AEAD id, §3
  reclaim_group_id      [u8; 16]
```

## 9. Receipts

```text
ReceiptEntryV1
  message_id   [u8; 16]
  status       u8   // 0x00 unknown, 0x01 downloaded, 0x02 decrypted, 0x03 displayed,
                    // 0x04 replied, 0x05 attachment_downloaded, 0x06 rejected (spec §8)
```

- Default user-facing behaviour sends only `downloaded` ("received") and
  `replied`; read receipts (`displayed`) are opt-in (spec §8).
- Receipts travel as piggybacked `receipts` in the next response payload
  (preferred), or as a standalone message with `content_type = 0x02` and no
  `text`. An acknowledgement cell is sender-owned by the acknowledgement
  sender and is itself reclaimable (spec §8).
- A response MUST set `reply_to_message_id` and SHOULD set
  `reply_to_outpoint`; this is what makes the original cell reclaim-eligible
  (spec §7.3).

## 10. Reclaim group (local journal — not published)

Reclaim groups are a local construct (spec §7.3, §9.5); nothing below is
published on-chain. Serialized into the `reclaim_groups` table and the
pre-broadcast transaction journal (AGENTS.md rule 6):

```text
ReclaimGroupV1
  reclaim_group_id   [u8; 16]
  reason             u8    // 0x01 acknowledged, 0x02 expired, 0x03 manual, 0x04 emergency
  created_at         u64
  outpoints          Vec<OutPointV1>   // message cell + CKBFS cells (Phase 10)
```

## 11. Size limits (hard)

Checked **before** decryption (spec §7.2) and before signing:

| Field                            | Limit                                                              |
| -------------------------------- | ------------------------------------------------------------------ |
| `text`                           | 16,384 bytes                                                       |
| `CempPayloadV1` total (Molecule) | 65,536 bytes (text MVP); 1,048,576 when attachments enabled        |
| `CempEnvelopeV1` cell data       | 82,000 bytes (text MVP)                                            |
| `handle`                         | 64 bytes                                                           |
| Profile data total               | 4,096 bytes                                                        |
| `mime_type`                      | 64 bytes                                                           |
| `padding`                        | 255 bytes                                                          |
| `attachment_manifests`           | 4 entries                                                          |
| `receipts`                       | 64 entries                                                         |
| `supported_protocol_versions`    | 8 entries                                                          |
| Attachment (Phase 10)            | 1,048,576 bytes encrypted; image longest edge 1,280 px (spec §9.1) |

## 12. Malformed-input behaviour

Treat all chain/RPC/indexer data as hostile (AGENTS.md rule 4). A processor
MUST, in this order:

1. **Shape:** strict Molecule decode — reject trailing bytes, invalid offsets,
   wrong fixed sizes. No partial parses.
2. **Version/algorithms:** reject unknown `protocol_version`, network byte,
   algorithm ids, or a `supported_protocol_versions` not containing the
   negotiated version.
3. **Limits:** reject any §11 violation _before_ attempting decapsulation.
4. **Crypto:** on ML-KEM decapsulation or AEAD failure, mark `invalid`, record
   a `security_events` entry, and never retry the same outpoint in a loop.
5. **Semantic:** payload `message_id` ≠ header, `recipient_profile_id` ≠ own,
   `body_type` ≠ header `content_type`, missing required `text`, unexpected
   receipt for an unknown message ⇒ `invalid` (no user-visible message).
6. Rejected inputs count toward per-route-tag and global rate limits
   (Phase 11). None of these rejects are user-facing errors; they are
   transport noise by design.

## 13. Molecule schema

The normative schema is `packages/cemp-core/schemas/cemp-v1.mol`. If this
document and the schema disagree, the schema plus golden vectors win and this
document must be corrected.

## 14. Golden vectors

Required for Phase 1 exit (ckd.txt Phase 1):

- Molecule round-trip vectors for every §5–§10 structure (including option
  present/absent arms and every limit boundary), in
  `packages/cemp-test-vectors/vectors/cemp-v1-serialization.json`.
- Cross-runtime: the same vectors decoded/re-encoded identically by the Rust
  codec (`contracts/` host side) and the TypeScript codec.
- Envelope end-to-end vector: fixed seed identities → fixed nonce →
  deterministic ciphertext (mirrors the mldsa-v2 vector approach).
- Fuzz-style malformed inputs (truncations, offset corruption, oversized
  declarations) MUST fail safely per §12 — property-tested, not just examples.

## 15. Metadata leakage (normative disclosure)

v1 provides **payload confidentiality only** (spec §15). Public on-chain:
route tag (pseudonymous but stable within an epoch), conversation tag,
cell sizes and timing, funding source, reclaim timing, attachment size ranges.
v1 mitigations are limited to: 0–255 B random padding, 30-day route-tag
rotation with previous-epoch grace, and batch reclaim. The product must not
claim stronger privacy; §15 of ckd.txt lists later options (padding buckets,
delayed reclaim, coin-selection hygiene, Tor/private RPC).
