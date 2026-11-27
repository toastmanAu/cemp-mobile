# ADR 0006: receipts carry proof of decryption (protocol version 2)

- Status: Proposed (2026-11-01)
- Context:
  - Phase A (`docs/review/PHASE-A-REPRODUCTION.md`) reproduced RCPT-01/02: a
    chain observer forges a `0x01` (message received) or `0x05` (attachment
    downloaded) receipt and makes the original sender reclaim the message
    cell and the image chunks before the recipient ever read them. The forger
    needs only public data: the cleartext header gives `message_id` and the
    sender id, `conversation_id = H(sorted(sender, recipient))` identifies the
    recipient against the public profile list, and route tags derive from
    public profile ids.
  - Commit `dbae853` binds a receipt to the original message's recipient, but
    v1 has no sender authentication, so the forger simply claims to BE the
    recipient. The binding stays; it is not sufficient on its own.
  - The full fix for sender spoofing (AUTH-01) is an ML-DSA-signed envelope
    (~3.3 KB per message, needs a profile-key resolver and rotation handling).
    That is a separate, larger ADR. The receipt attack destroys funds and
    undelivered data today, so it is fixed first, on its own.
  - Key observation: exactly two parties can decrypt message M, the sender and
    the intended recipient. Both can derive key material from M's ML-KEM
    shared secret. A receipt that proves knowledge of that material proves
    the receipt came from someone who could decrypt M, with no signature and
    no profile lookup.
  - CEMP Molecule tables reject unknown fields (`packages/cemp-core/src/codec/
codecs.ts`), so ANY change to the receipt entry is a breaking wire change
    and must be versioned.

## Decision

### Receipt key (per message)

For every content message, both sides derive, from the same values they
already use for the message key (spec §3, `deriveMessageKey`):

```text
PRK         = HKDF-Extract(salt = envelope_nonce, IKM = ml_kem_shared_secret)
receipt_key = HKDF-Expand(PRK, "CEMP-RECEIPT-KEY-V1" || sender_profile_id || recipient_profile_id, 32)
```

`CEMP-RECEIPT-KEY-V1` is a new entry in the domain registry
(`packages/cemp-crypto/src/domains.ts`), distinct from the message and
attachment key domains, so the receipt key reveals nothing about either.

- The SENDER keeps `receipt_key` on the outgoing message row.
- The RECIPIENT keeps `receipt_key` on the incoming message row. It is needed
  later: the `0x05` receipt is sent only after the user taps to download, and
  the message cell may be reclaimed by then (same reasoning as the persisted
  attachment key, schema v8).
- Both live in the SQLCipher-encrypted database (new `messages.receipt_key`
  BLOB column, next schema version). Never logged, never on the wire.

### Receipt proof

```text
proof = HMAC-SHA256(receipt_key, "CEMP-RECEIPT-PROOF-V1" || message_id[16] || status[1])
```

All fields are fixed length, so the concatenation is unambiguous. `status` is
inside the MAC, so a genuine `0x01` cannot be re-labelled as `0x05`. The
original `message_id` is inside the MAC, so a proof cannot be moved to a
different message.

### Wire format: protocol version 2

```text
table ReceiptEntryV2 {
  message_id: Byte16,
  status: byte,
  proof: Byte32,
}
vector ReceiptVecV2 <ReceiptEntryV2>;

table CempPayloadV2 {      // CempPayloadV1 with receipts: ReceiptVecV2
  ...all CempPayloadV1 fields, same order...
  receipts: ReceiptVecV2,
  ...
}
```

- The envelope header table is unchanged. Its `protocol_version` byte is the
  discriminator: `1` decodes the payload as `CempPayloadV1`, `2` as
  `CempPayloadV2`. The decoder dispatches on that byte explicitly; it never
  tries one layout and falls back to the other. Any other value is rejected.
- The on-chain message type script checks type-args length and version only;
  type args are unchanged, so no contract redeploy is needed. Confirmed:
  `contracts/cemp-message-type/src/lib.rs` `validate_type_args` checks only
  `args.len() == 81` and `args[0] == 1`, and `main.rs` loads only its own
  script (never cell data). The type-args version byte is the constant
  `MESSAGE_TYPE_ARGS.version = 0x01` in `packages/cemp-ckb/src/builders.ts`
  `buildMessageTypeArgs`, independent of the envelope's `protocol_version`.
  Pinned by the test "a v2 message cell carries the unchanged 81-byte v1 type
  args" in `packages/cemp-ckb/src/receipt-auth.test.ts`.
- All outgoing messages (content, receipt-only, content-plus-receipt) are
  sent as version 2. No v1 send path remains, so there is nothing to silently
  downgrade to.
- Golden vectors: v1 vectors stay byte-for-byte unchanged (historical
  decoding); new v2 vectors are added, including a known-answer vector for
  `receipt_key` and `proof`.
- Implementation notes: the v2 schema additions live in
  `packages/cemp-core/schemas/cemp-v2.mol` (read with `cemp-v1.mol`); v2
  vectors are `cemp-v2-serialization.json` (generated) and
  `cemp-v2-receipt.json` (receipt key and proof known answers, computed with
  an independent Python HKDF/HMAC oracle). Profiles are unchanged and still
  advertise protocol version 1. Senders supply each outgoing receipt as
  `{messageId, status, proof}` (`ProvenReceipt`), computing the proof from
  the receipt key stored on the original incoming row; assembly never sees a
  receipt key. A v1 incoming message yields no receipt key (its sender cannot
  verify a proof), so it is never acked.

### Acceptance (the original sender processing a receipt)

A receipt changes state or capacity only if ALL hold:

1. it arrived in a version-2 payload;
2. its `message_id` names an OUTGOING row whose conversation contact is the
   receipt's claimed sender (the recipient binding from `dbae853`);
3. that row has a stored `receipt_key`;
4. `proof` verifies in constant time for that `message_id` and `status`.

Anything else (v1 receipts, rows sent before the upgrade, a bad proof) is
ignored: no transition, no reclaimable capacity, no attachment flag, and the
rest of the payload is still processed normally. A replay of a genuine
receipt is harmless: transitions are already idempotent.

### Compatibility and migration

- Testnet only. This is a flag day: devices on the old build cannot decode
  version-2 envelopes (they reject the version byte), and their v1 receipts
  are ignored by new builds. All test devices update together.
- Historical v1 messages still decrypt and display; their receipts never
  trigger reclaim.
- Outgoing rows created before the upgrade have no `receipt_key` and can never
  be auto-reclaimed by a receipt. Their capacity stays locked until a separate
  recovery path (expiry-based or manual reclaim) releases it. That path is out
  of scope here and listed as a follow-up.
- The receipt binding from `dbae853` stays as defence in depth.

## Consequences

- Fixes RCPT-01/02/04 (receipt forgery by anyone who cannot decrypt the
  original message). Does NOT fix AUTH-01 sender spoofing: a forged CONTENT
  message is still possible until the signed envelope lands.
- Cost: +32 bytes per receipt entry, about +32 CKB of locked capacity per ack
  cell, returned on reclaim.
- The signed-envelope work becomes protocol version 3 and keeps
  `ReceiptEntryV2` unchanged.
- Recipient privacy (the cleartext `conversation_id` identifies the recipient)
  is unchanged by this ADR and is recorded for the version-3 design.
