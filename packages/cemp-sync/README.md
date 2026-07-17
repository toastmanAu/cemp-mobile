# @cemp/sync

Background operation for CEMP Mobile (spec Phase 9, §12). Platform-neutral
sync engine + worker implementations over the Phase 7/8 pipelines. The
Android WorkManager bridge (apps/android, device phase) is a thin mapping of
the `Scheduler` interface; everything else — retry, cursors, leases, endpoint
rotation, notifications — is tested headlessly here.

## Pieces

| Module         | Phase 9 tasks  | What it does                                                                                                                                  |
| -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`    | 1, 2, 5, 9, 10 | `SyncEngine` + `Scheduler` interface + `InMemoryScheduler`. Worker-level leases, persisted retry attempts, foreground catch-up (`runAllNow`). |
| `retry.ts`     | 3              | `BackoffPolicy`: exponential with ±25% jitter, capped, injectable randomness.                                                                 |
| `endpoints.ts` | 7              | `EndpointRotator`: N consecutive failures → round-robin advance, persisted via sync cursor (reboot keeps the healthy endpoint).               |
| `workers.ts`   | 4, 6, 8, 9, 10 | The §12 workers wired to the pipelines (see below).                                                                                           |

## Workers and cadence (task 6)

Everything is at or above the WorkManager 15-minute floor; user-visible
latency comes from foreground catch-up (app open / reconnect calls
`runAllNow`), not aggressive polling.

| Worker                 | Interval | Behaviour                                                                                                                                                                                                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `incoming-discovery`   | 15 min   | Route-tag scan (current + previous epoch) with per-epoch persisted cursors; per-cell outpoint leases (task 9); dedups on the envelope message id; posts a `messages`-channel notification (task 8); receipts inside replies feed the Phase 8 ack flow. |
| `response-sender`      | 15 min   | Drains `response_queued` (`response:<originalLogicalId>`, UNIQUE → no duplicate responses, exit criterion 3); publishes with the 0x01 receipt + `reply_to`; registers the original-cell watch (Phase 8 task 9).                                        |
| `pending-transactions` | 15 min   | Journaled `submitted` txs → committed/rejected; advances message states; reclaim txs delegate to the lifecycle resume path.                                                                                                                            |
| `watched-outpoints`    | 30 min   | `ResponseLifecycle.pollWatchesOnce` — remote-reclaim detection.                                                                                                                                                                                        |
| `reclaim-batch`        | 60 min   | `ResponseLifecycle.executeReclaimBatch` under the `reclaim:batch` database lease (task 10).                                                                                                                                                            |
| `balance-refresh`      | 30 min   | Slot reserved for the Phase 4 indexer balance feed.                                                                                                                                                                                                    |
| `profile-refresh`      | 6 h      | Slot reserved for own-profile revalidation.                                                                                                                                                                                                            |
| `database-maintenance` | 24 h     | Prunes expired worker leases (and spent watches via the lifecycle).                                                                                                                                                                                    |

## Android WorkManager mapping (device phase)

- `schedulePeriodic` → `PeriodicWorkRequest` (15-minute floor respected) with
  `NetworkType.CONNECTED` for `requiresNetwork` workers (task 2).
- `scheduleOneShot(id, delay)` → `OneTimeWorkRequest` with initial delay
  (the retry path; WorkManager persists it across reboot natively).
- Scheduled work itself — queued messages, the tx journal, watches, cursors,
  leases — lives in the encrypted database, so process death and reboot lose
  nothing (exit criterion 2, tested as close/reopen in `workers.test.ts`).

## Exit criteria coverage (tests)

- _Messages are discovered after the app has been backgrounded_ —
  `incoming-discovery` e2e: cell → decrypt → insert → notify, cursor persisted.
- _Reboot does not lose scheduled work_ — pending-tx completion across a
  close/reopen with a fresh engine instance.
- _Duplicate workers do not produce duplicate responses or reclaim
  transactions_ — worker leases (`skipped-lease`), outpoint leases, the
  UNIQUE response logical id, and the idempotent journal each tested.
