# ADR 0009: decide "spent" from evidence, because a real node never says `dead`

- Status: Accepted (2026-11-27)
- Fixes a Phase 8 defect that ADR 0008 inherited. No wire or schema change.

## Context

- Three places waited for `get_live_cell` to answer `dead` before acting on a
  spent cell:
  - the responder watch (`ResponseLifecycle.pollWatchesOnce`), which moves the
    incoming original to `remote_reclaimed`. ADR 0008's `0x01` fast path depends
    on that state.
  - ADR 0008's `0x05` chunk check (`chunkCellsSpent` in `cemp-sync`);
  - the reclaim batch's "already spent while we were offline" branch
    (`executeReclaimBatch`).
- **A real CKB node does not report spent cells as `dead`.** `get_live_cell`
  does not track consumed cells and answers `unknown`. Testnet, 2026-11-26:
  - the Samsung's v3 message cell `0xf95ef7b8…:0` was spent by its reclaim at
    01:21:40;
  - `get_live_cell` answered `"unknown"` for it, while the Retroid's live ack
    answered `"live"`.
- So the responder watch has never fired on a real node, and every ack waited
  the full 30-day ADR 0008 fallback. A reclaim-queued row whose cell had
  already gone stayed `reclaim_queued` forever.
- No test caught it: the mock node answered `dead`.

## Decision

`resolveOutPointFate(client, outPoint)` (`packages/cemp-ckb/src/outpoint-fate.ts`)
returns `live`, `spent` or `unknown`:

- `live` when `get_live_cell` says live; `spent` when it says `dead`;
- otherwise `spent` ONLY when ALL hold:
  1. the creating transaction is `committed`;
  2. it is at least `SPENT_CONFIRMATION_DEPTH` (24 blocks, ~3 minutes) below
     the tip;
  3. the out point's index is within that transaction's outputs.

  So the cell provably existed, every node behind a load-balanced endpoint has
  had time to see it, and it is no longer live.

- Anything short of that is `unknown`, which the callers keep treating as "no
  information, retry next pass". Review E4's caution stands.

The three call sites use it. Callers that treat any non-`live` answer as gone
(discovery's `watchOutpointUntilSpent`, attachment receive, attachment group
reclaim) were already correct and are unchanged.

## Consequences

- The responder watch fires within a sync pass of the sender's reclaim, and
  ADR 0008's fast path now actually works. The 30-day fallback goes back to
  being a fallback.
- Each check costs up to three extra RPC reads (`get_transaction` twice,
  `get_tip_header`), and only for cells that are not live.
- Residual: a cell created and spent within the last 24 blocks reads `unknown`
  until it is 24 blocks deep. That is a delay, never a wrong answer.

## Tests

- `packages/cemp-ckb/src/outpoint-fate.test.ts` (9).
- In `packages/cemp-sync/src/workers.test.ts`, 3 `REAL NODE` tests that use a
  fake node answering the way testnet did (`unknown` + committed creating tx),
  plus a no-evidence control.
- Each of the 6 guards (committed, depth, index range, and each call site) was
  mutation-probed on its own, rebuilding `@cemp/ckb` for the call-site probes;
  its named test went red every time.

## Review (2026-11-27)

An independent code review found no critical or high issues. It found no way
to get a false `spent` from a single consistent node. Fixed, each with a test
written first and a mutation probe:

- **M1, one bad row aborted everything.** `resolveOutPointFate` makes up to
  five RPC reads. A throw from any of them aborted the whole reclaim batch or
  watch poll, so one row whose creating tx failed to parse could block every
  reclaim. The helper now never throws: a node error is `unknown` for that out
  point only.
- **M2, capacity left in reclaimable.** The reclaim batch's `spent` branch
  moved the row to `reclaimed` but never released the capacity that queueing
  had funded. It now releases the journaled capacity. A double release is
  impossible: the resume path releases only after moving its rows to
  `reclaimed`. The spending tx's fee is unknown, so it is not burned; the
  balance refresh reconciles.
- **LOW-1, lagging backend.** Behind a load-balanced endpoint, the first
  `unknown` may come from a backend more than 24 blocks behind, while another
  backend supplies the "committed deep" evidence. `get_live_cell` is now read
  again after the evidence, and both reads must say not-live.
  This mitigates the case; it does not eliminate it. Pinning every read to one
  backend is not possible over a plain JSON-RPC URL.

Accepted (LOW-2): a watch whose creating tx is never found costs up to three
extra RPCs per poll for as long as the watch exists.
