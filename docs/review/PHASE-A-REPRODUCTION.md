# Security Phase A — Vulnerability Reproduction Report

**Branch:** `security/authenticated-messaging-v2` (from `main` @ `2b5a3d7`)
**Scope:** Phase A of the CellSend security hardening handoff. Matrix rows
AUTH-01, AUTH-02, RCPT-01..04 and TRNS-01.
**Status:** tests only. No production code changed. Nothing broadcast (mock
chain transport and mock CCC client throughout).

Every test below **passes today because it asserts the vulnerable
behaviour**. Each `describe` block is named `VULN reproduction (pre-fix): …`.
When Phases C/D/E land, these assertions should fail. Rewrite them then as
post-fix rejection tests. Do not weaken the fix to keep them green.

Mutation check: with `processAcknowledgements` made to ignore every receipt,
all 6 receipt reproductions in `receipt-auth.test.ts` fail and the 2
"NOT reproduced" controls still pass. The assertions do depend on the
vulnerable code path.

## Why the attacker preconditions are minimal

The preconditions for every finding are **read access to the chain and the
ability to publish one transaction**. No secret key belonging to any victim
is involved. This holds because of three facts, each checked against the
code:

1. **The envelope header is cleartext.** `CempEnvelopeHeaderV1` is the AEAD
   AAD, not ciphertext (`packages/cemp-crypto/src/envelope.ts`). Any chain
   reader can decode the following from a published message cell with
   `codec.decodeCempEnvelopeV1`:
   - `message_id`: the 16-byte key that receipts are matched on.
   - `sender_profile_id`
   - `conversation_id`
2. **The intended recipient can be recovered.** `conversation_id =
H(sorted(sender, recipient))` (`deriveConversationId`). Testing each
   public profile id against it identifies the recipient.
3. **Inboxes are addressable from public ids.** Route tags are
   `deriveRouteTag(publicProfileId, epoch)`
   (`packages/cemp-core/src/identity.ts:59`). Encrypting a message only
   needs the recipient's public ML-KEM key, which sits in their on-chain
   profile cell.

v1 has no sender signature over the envelope. The ML-DSA signature on the
CKB transaction proves who spent the **inputs**. It says nothing about the
`sender_profile_id` written into an **output's** data, or about the output
lock. The on-chain `cemp-message-type` script checks only the type-args
length and version byte (`contracts/cemp-message-type/src/lib.rs`
`validate_type_args`).

## Findings

### AUTH-01: sender impersonation. REPRODUCED

**Reproduction.** Mallory calls `assembleTextMessage` with
`senderProfileId = Alice`, `recipientProfileId = Bob` and
`recipientKemPublicKey = Bob's public key`. `processIncomingText` on Bob's
device decrypts the message and validates it, then returns
`senderProfileId = Alice`, read directly from the attacker-written header
(`packages/cemp-ckb/src/incoming.ts`). The result has the same fields, sender
and conversation as a genuine Alice message. Mallory can also claim an id
that has never existed, and it is still accepted.

**Sync pipeline.** `ingestIncomingCellData`
(`packages/cemp-sync/src/workers.ts:281`) uses the claimed id for the
blocked-sender check, the rate-limit bucket and contact lookup. If Bob
already has Alice as a contact, the forged message is inserted into **Bob's
existing Alice conversation** with no new contact. Bob's device also queues
an auto-ack addressed to "Alice", so Bob spends capacity replying to a
message Alice never sent.

**Attacker preconditions.** Alice's public profile id, Bob's public KEM key,
and one funded transaction from Mallory's own wallet.

**Affected state.** An incoming row goes `discovered → … → received` inside
the Alice conversation. A notification is posted. On the chain path, one
outgoing `response:` row is queued, which later spends Bob's capacity.

**Tests.**

- `packages/cemp-ckb/src/incoming-auth.test.ts`, in "AUTH-01 sender
  impersonation in processIncomingText", 4 tests:
  - accepts a Mallory-built envelope …
  - structurally indistinguishable …
  - AES-GCM tag proves only knowledge of Bob's PUBLIC key …
  - sender_profile_id is CLEARTEXT …
- `packages/cemp-sync/src/authentication.test.ts`, in "AUTH-01 spoofed
  sender lands in Alice's conversation": the test "a Mallory-funded cell
  claiming Alice is inserted into Bob's EXISTING Alice conversation and
  auto-acked to 'Alice'".

**Seen while reading the code, not tested.** The incoming rate limiter is
keyed on the _claimed_ sender. Mallory can therefore use up Alice's
per-contact budget on Bob's device, and Bob's app will then drop Alice's
genuine messages. A blocked Mallory can also get around her block by
claiming any other id.

### AUTH-02: output lock or transaction spender treated as sender proof. REPRODUCED (structurally)

**Reproduction.** Two forged "Alice" cells go through the real
incoming-discovery worker: one with an output lock that looks like Alice's,
one locked to Mallory. Both are ingested identically as "from Alice" into
Alice's conversation. `processIncomingText` takes only
`{cellData, ownKemSecretKey, ownProfileId}`, and `ingestIncomingCellData`
takes only cell data and an outpoint. No lock, input or spender value reaches
the sender decision. The type args (route tag, conversation tag, nonce) are
all derivable from public ids, so they carry no sender binding either.

**Attacker preconditions.** Same as AUTH-01. CKB never executes output locks
when a cell is created, so Mallory can attach any output lock while spending
only her own inputs.

**Limitation.** No real transaction with a foreign output lock is built or
broadcast. The production builder `buildSendMessageTx` always uses the
sender's own lock, so an attacker would use their own tooling. The tests
prove the claim from the other side: the receive path never reads the lock.

**Tests.**

- `incoming-auth.test.ts`, in "AUTH-02 output lock / transaction spender is
  not sender proof", 2 tests.
- `authentication.test.ts`, in "AUTH-02 output lock is ignored by
  ingestion", 1 test.

### RCPT-01: forged `0x01` receipt. REPRODUCED, including the reclaim spend

**Reproduction.**

1. Alice publishes a genuine message to Bob as a message cell locked to her
   wallet. Her store row is `available_on_chain`, and the publication journal
   records 500 CKB of capacity.
2. Mallory's forging function receives **only** three things: Alice's
   published cell bytes, Alice's public KEM key, and a public profile
   directory. From these it:
   - decodes the clear header to get `message_id` and Alice's id;
   - identifies Bob by matching the conversation id;
   - builds a receipt-only envelope to Alice that claims Bob as sender and
     carries `{message_id, 0x01}`.
3. Alice's normal pipeline accepts it. `ResponseLifecycle.processAcknowledgements`
   (`packages/cemp-ckb/src/lifecycle.ts:174`) looks the message up by
   `message_id` alone. It never compares `incoming.senderProfileId` with the
   message's intended recipient, and never checks the conversation.

**Affected state and balance.**

- **Delivery state.** The message walks `available_on_chain →
downloaded_by_recipient → acknowledged → reclaim_queued`.
- **Balance.** `markCapacityReclaimable(500 CKB)` runs, so the DB balance
  moves from reserved to reclaimable.
- **Reclaim.** On the next `executeReclaimBatch`, a reclaim transaction that
  **consumes the undelivered message cell** is signed and handed to the
  (mock) node. The row becomes `reclaimed` and the net capacity is released
  to available. Bob can then no longer fetch the message from a live cell.
  Ciphertext may survive in block history, but the app reads live cells.
- **UI.** The sender's chat shows the message as delivered.

**Attacker preconditions.** Chain read access, Alice's public KEM key, and
one transaction. It also works over the chain-less LoRa path (TRNS-01).

**Tests.**

- `packages/cemp-ckb/src/receipt-auth.test.ts`, in "RCPT-01 forged 0x01
  receipt from public chain data", 2 tests: the state and capacity walk, and
  the reclaim spend of the message cell.
- `authentication.test.ts`, in "RCPT-01/02 forged receipts through the sync
  pipeline", 3 tests:
  - the real DB balance moves from reserved to reclaimable;
  - the incoming-discovery worker finds the forged receipt under Alice's
    _public_ route tag;
  - the LoRa variant behaves the same.

### RCPT-02: forged `0x05` attachment receipt. REPRODUCED, including the chunk release

**Reproduction.** Same forgery as RCPT-01, with status `0x05`.
`processAcknowledgements` calls `markAttachmentRemoteDownloaded(rowId)`. This
path has **no state guard**: it fires even when the row is still `pending`.
In the sync pipeline, a forged `0x01` and `0x05` arrive together. The
message is then reclaimed and the `reclaim-batch` worker passes the image's
**chunk outpoints** to `reclaimAttachmentGroup`. That is the irreversible
step the `0x05` gate exists to prevent, because the chunks are the only copy
of the image.

**Affected state.** `attachments.remote_downloaded = 1`, and the image chunk
cells become eligible for reclaim.

**Mock caveat.** The fake transport reports the message cell as already
spent. The batch therefore marks it `reclaimed` without building a
transaction. The live-cell spend is demonstrated in `receipt-auth.test.ts`
instead. The chunk handoff to `reclaimAttachmentGroup` is real worker
behaviour. `reclaimAttachmentGroup` itself is injected and records its calls.

**Tests.**

- `receipt-auth.test.ts`, in "RCPT-02 forged 0x05 attachment receipt", 2
  tests.
- `authentication.test.ts`, the "chain discovery: forged 0x01+0x05 → …
  chunks reclaimed" test.

### RCPT-03: a genuine third party (Carol) acks a message meant for Bob. REPRODUCED

**Reproduction.** Carol identifies herself truthfully. Her receipt has
`senderProfileId = Carol` and conversation `H(Alice, Carol)`, and it
references the Alice→Bob `message_id`. It is accepted, and the message goes
to `reclaim_queued` with capacity marked reclaimable.

**Note.** v1 has no envelope signature, so "valid signer Carol" can only mean
that Carol names herself honestly and funds and signs her own CKB
transaction. After v2 adds envelope signatures, this row still needs the
Phase E recipient-binding check. A valid signature from the wrong party must
be rejected.

**Test.** `receipt-auth.test.ts`, in "RCPT-03 a real third party (Carol) acks
a message meant for Bob".

### RCPT-04: wrong conversation, network or message id. PARTIALLY REPRODUCED

| Variant            | Verdict                                | Why                                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong conversation | **REPRODUCED**                         | `validateSemanticConsistency` checks only `message_id`, `body_type` and `recipient_profile_id`. `conversation_id` is never checked against `H(sender, recipient)`, so an all-zero id is accepted. The lifecycle never compares it with the target message's conversation either. The receipt still acks. |
| Wrong network      | **NOT reproduced**                     | `codec.validateEnvelope` rejects any network byte other than `0x01` (testnet). That includes the reserved mainnet byte `0x00`, and the check runs before decapsulation. v1 accepts only one network, so there is nothing to confuse. Phase E must still bind the network once mainnet exists (AUTH-08).  |
| Wrong message id   | **NOT reproduced** (correct behaviour) | A receipt whose id matches no outgoing row is skipped, with zero state, capacity or attachment effects. The weakness is the opposite case: the _right_ id from the _wrong_ sender (RCPT-01/03).                                                                                                          |

**Tests.** `receipt-auth.test.ts`, in "RCPT-04 wrong conversation / network
/ message id", 3 tests. The two "NOT reproduced" tests are controls and are
expected to stay green after the fix.

### TRNS-01: transport parity. REPRODUCED (both transports equally vulnerable)

**Reproduction.** The same spoofed envelope bytes go through
`ingestIncomingCellData` once with a chain source and once with
`source: null`, which is the LoRa relay tail. Both insert a `received` row
into Alice's conversation with the same body. The only difference is
plumbing: the chain path records a chain ref and queues an auto-ack, and
LoRa does neither. LoRa has no transaction at all, so it has no spender to
verify even in principle.

The same forged **receipt** bytes also produce identical lifecycle effects on
both transports: `reclaim_queued`, reserved to reclaimable, and
`remote_downloaded`. LoRa's "receive-only" status covers only _outgoing_
acks. _Incoming_ receipts over LoRa still reach `processAcknowledgements`.

**Tests.** `authentication.test.ts`:

- "TRNS-01 identical spoofed bytes via CKB and via LoRa (source: null)";
- "TRNS-01 receipts: the same forged receipt bytes via LoRa (source: null)
  have the same lifecycle effect".

## Status after the receipt→recipient binding (follow-up commit)

`ResponseLifecycle.processAcknowledgements` now accepts a `0x01`/`0x05`
receipt only when its claimed sender equals the profile id of the contact the
original OUTGOING message's conversation is with (fails closed if that
contact has no profile id; never matches an incoming row). Wire-compatible.

| Finding                      | Status         | Why                                                                                                                                                                                                 |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RCPT-03                      | **FIXED**      | Carol naming herself no longer matches Bob. Test flipped to assert no effect.                                                                                                                       |
| RCPT-01 / RCPT-02            | **STILL OPEN** | The forgery claims to BE Bob. The cleartext `conversation_id = H(sorted(alice, bob))` lets any observer find Bob by hashing Alice's id against public profile ids, so the claim passes the binding. |
| RCPT-04 (wrong conversation) | **STILL OPEN** | Same: the impersonating sender id is Bob's.                                                                                                                                                         |
| AUTH-01/02, TRNS-01          | **STILL OPEN** | Unchanged; needs sender authentication.                                                                                                                                                             |

Closing RCPT-01/02 requires an AUTHENTICATED receipt, i.e. a wire change.
Two candidates: (a) the v2 ML-DSA-signed envelope (~3.3 KB per message,
also fixes AUTH-01), or (b) a receipt that proves decryption, e.g. a 32-byte
MAC keyed by the original message's key, which only Alice and Bob hold (~32
bytes per receipt; fixes receipts only, not AUTH-01).

Additional finding while doing this: the cleartext `conversation_id`
effectively publishes the RECIPIENT of every message to anyone holding the
public profile list, contrary to the envelope comment that the recipient is
not in the clear header.

## Test inventory

| File                                            | Tests                                           |
| ----------------------------------------------- | ----------------------------------------------- |
| `packages/cemp-ckb/src/incoming-auth.test.ts`   | 6                                               |
| `packages/cemp-ckb/src/receipt-auth.test.ts`    | 8 (6 reproductions + 2 NOT-reproduced controls) |
| `packages/cemp-sync/src/authentication.test.ts` | 6                                               |

Commands run:

```bash
pnpm -r run build
npx vitest run packages/cemp-ckb/src/incoming-auth.test.ts \
  packages/cemp-ckb/src/receipt-auth.test.ts packages/cemp-sync/src/authentication.test.ts
npx vitest run   # full suite: 757 passed, 1 skipped
npx eslint <new files>; npx prettier --check <new files>
```

## Harness notes

- `receipt-auth.test.ts` uses a recording in-memory `LifecycleStore`.
  `cemp-ckb` cannot depend on `cemp-database`, and the repo has no existing
  full `LifecycleStore` fake. `cemp-images/src/test-helpers.ts` fakes only the
  reclaim subset. The chain fixture copies the `makeChain` pattern from
  `packages/cemp-database/src/lifecycle.test.ts`.
- `authentication.test.ts` mirrors `makeStack` from `workers.test.ts`, which
  is not exported. It adds one parameter for which identity owns the device,
  so the same harness can play Bob (impersonation victim) and Alice
  (receipt-forgery victim). It uses the real DB stack, workers and assembly.
- All keys come from deterministic BIP39 test vectors and are used only in
  tests.
