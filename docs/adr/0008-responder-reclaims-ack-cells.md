# ADR 0008: the responder reclaims its own acknowledgement cells

- Status: Accepted (2026-11-26)
- Builds on ADR 0005 (acknowledgement responses). No wire change.

## Context

- An acknowledgement (`response:` carrying a `0x01`, or `ack-attachment:`
  carrying a `0x05`) is an ordinary OUTGOING message cell, funded by the
  recipient of the original message.
- Outgoing rows reach `reclaim_queued` only via `acknowledged`, and only an
  incoming receipt moves a row there. ADR 0005 deliberately ends the exchange:
  receipt-only messages are never acked back. So **no ack cell ever became
  reclaimable**. Every ack stopped at `available_on_chain` forever.
- Measured on testnet, 2026-11-26 (all live cells under the CEMP message type
  `0xd172d3bf…`, headers decoded): 56 live message cells, of which 32 are acks
  whose original cell had already been reclaimed by its sender. They were
  24–131 days old (median 102) and held 59,459 CKB that nothing would ever
  release.
- Protocol v3 (ADR 0007) adds a 3,309-byte signature to every message, so a
  receipt-only cell is ~5,236 CKB instead of ~1,936 CKB. At that size a
  receive-mostly device (the Retroid test phone holds ~4,512 CKB) cannot fund
  a single ack, and every message sent to it then stays locked for its sender.
  This blocks testnet readiness.

## Decision

The responder reclaims its own ack cell when `shouldReclaimAck`
(`packages/cemp-sync/src/ack-reclaim-policy.ts`) says so:

1. **On proof the sender consumed the ack**, which differs per kind:
   - `0x01`: the original MESSAGE cell is dead. The sender spends it only
     after processing our `0x01`, and the existing responder watch already
     records that spend (`remote_reclaimed`).
   - `0x05`: a CHUNK cell of the original image is dead. The message cell
     proves nothing here: it was reclaimed on the earlier `0x01`, possibly days
     before the recipient tapped to download. Reclaiming a `0x05` on that
     evidence could delete it before the sender's next sync, so the sender
     would never reclaim its image chunks (about 1 CKB per byte, locked
     forever).
   - A live-cell answer of `unknown` is never treated as dead (review E4).
2. **Or after a 30-day fallback** (`ACK_RECLAIM_FALLBACK_MS`), measured from
   the ack's journaled commit time (else submit time, else row creation), so
   a sender that never comes back cannot lock the responder's capacity
   forever. A clock reading earlier than the commit never satisfies it.

Mechanics: `queueReclaimableAcks` runs inside the `reclaim-batch` worker,
under its lease, before `executeReclaimBatch`. It hands each eligible row to
`ResponseLifecycle.queueAckForReclaim`, which walks the same legal state edges
a receipt would (`available_on_chain → downloaded_by_recipient →
acknowledged → reclaim_queued`) and funds the reclaimable bucket from the
journal, exactly as `processAcknowledgements` does. The existing batch
reclaim then spends the cell. No state-machine change, no schema change, no
migration: the worker scans every `available_on_chain` ack each pass, so the
existing backlog on each device is released on its first pass after upgrade.

## Consequences

- Ack capacity now returns to the recipient: on the sender's reclaim for a
  `0x01`, on the sender's chunk reclaim for a `0x05`, or after 30 days.
- **Trade-off of the fallback.** If the sender is offline for more than 30
  days, the ack is gone when it returns: its message stays "sent" and its own
  cell is not reclaimed by a receipt. That sender-side recovery path (manual
  or expiry-based reclaim of the sender's own unacked cells) is not in this
  ADR and is tracked as a follow-up.
- Ack rows walk `downloaded_by_recipient` and `acknowledged` although no
  receipt arrived for them. They are hidden from the UI
  (`listByConversation` excludes them), so the labels are bookkeeping only.
- Each device recovers only its own backlog, and only once it runs this build.
- Recovery needs one reclaim transaction per batch, paid from the recovered
  capacity, as for any reclaim.

## Review (2026-11-26)

An independent code review found no critical or high issues. Two medium
findings were fixed, each with a regression test written first:

- **Crash mid-walk stranded the ack.** The walk and the funding are separate
  writes. A row left at `downloaded_by_recipient` or `acknowledged` was never
  re-examined. The scan now covers every ack-able state, and
  `queueAckForReclaim` reads the state fresh. Funding happens only on arrival
  at `reclaim_queued`, so a resumed row is funded once.
- **500-row window.** `listByState` caps at 500 oldest rows, and unacked
  content rows share `available_on_chain`, so on a long-lived device the acks
  could be starved forever. Acks now come from `listOutgoingAcks`, filtered in
  SQL.

Also: a failure in the ack pass no longer blocks `executeReclaimBatch`.

**Residual, not fixed here.** A crash or a funding error AFTER the row reaches
`reclaim_queued` but BEFORE `markCapacityReclaimable` leaves a queued, unfunded
row. Its later release then fails or draws on other rows' share. The same
window already exists in `processAcknowledgements`. Closing it needs one atomic
DB-layer call for both paths: `transitionState` and the balance moves each open
their own non-reentrant transaction, so they cannot simply be wrapped.
Follow-up.

## Tests

`packages/cemp-sync/src/ack-reclaim-policy.test.ts` (boundaries, skew) and
the "ack-cell reclaim (ADR 0008)" block in `packages/cemp-sync/src/workers.test.ts`
(11 tests). Each guard was mutation-probed on its own and its named test went
red: `0x05` using message-cell evidence, `unknown` treated as dead, the
ack-only filter removed, the age fallback disabled, and the lifecycle
state re-check removed, the resume states dropped, and the ack-only query replaced by `listByState` (with `@cemp/ckb` rebuilt, since `@cemp/sync` consumes
its `dist/`).
