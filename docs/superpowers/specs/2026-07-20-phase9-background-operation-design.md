# Phase 9 — Background operation (design)

- Date: 2026-07-20
- Status: approved, not yet implemented
- Spec reference: `ckd.txt` §"Phase 9: Background operation"

## Problem

Phase 9's workers already exist and are exercised by the test suite: incoming
discovery, response sender, pending-transaction reconciliation, reclaim
batching, watched outpoints, balance refresh, plus leases, retry/backoff and
endpoint rotation. What is missing is that **nothing schedules them**.

The app installs `InMemoryScheduler` — whose own doc comment says "reference
scheduler (tests + dev): records intent, no timers" — and `NoopNotifier`.
Sync therefore only happens when the Chats tab gains focus (`useFocusEffect`
→ `syncNow()`). During the 2026-07-19 two-device bring-up this had to be
hand-cranked by toggling tabs to force every sync.

The spec's exit criterion "messages are discovered after the app has been
backgrounded" is not met.

## Constraints

Three constraints shape the design. All were verified in the codebase, not
assumed.

1. **The encrypted database cannot be opened while the vault is locked.**
   `getDatabaseKey()` is unlocked-only, and the biometric wrap slot requires a
   user-presence prompt (`setUserAuthenticationRequired`). There is no
   non-interactive key path, by design.

2. **A HeadlessJS task runs in the app's JS context.** If Android has killed
   the process, a _fresh_ context starts, and the vault encryption key exists
   only in memory — so a cold start is equivalent to locked. Combined with the
   five-minute auto-lock, **notify-only is the common path on an idle phone**,
   not an edge case.

3. **WorkManager's periodic floor is 15 minutes**, and booting the React
   Native JS context is the expensive part of a tick.

## Decisions

**D1 — While locked, notify only.** The background worker detects that cells
exist for our route tag and posts a notification. It never decrypts and never
opens the database. The alternative — adding a device-bound keystore slot so
background work could open the DB while locked — was rejected: it would make
the database key retrievable by anything with device or root access, which
defeats the at-rest security model.

**D2 — Cache route tags, never the profile id.** The locked probe needs
something to query. Leaking the _profile id_ would let anyone derive our inbox
tag for every epoch, past and future; leaking a _route tag_ exposes only that
epoch. We therefore cache the derived tags for the **previous, current and
next** epoch in a non-biometric Keystore entry (via the existing
`PlatformKeyStore` seam), never the profile id. Caching the _next_ epoch's tag
matters: without it an epoch rollover while locked silently blinds the probe
until the next unlock.

**D3 — All protocol logic stays in TypeScript** (approach A). One WorkManager
tick boots a `HeadlessJsTaskService` which runs the existing TS engine. The
rejected alternative was a Kotlin-native locked probe (cheaper — no JS boot),
but it would duplicate the chain-query logic in a second, untested language.
That logic is the most treacherous code in the system: the 2026-07-19 session
found that a prefix search is ordered by type args ending in a _random nonce_,
so cursor-based resumption silently skips cells. One implementation, one place
to get it wrong.

**D4 — Coalesce periodic work.** `Scheduler.schedulePeriodic` is per-worker, so
a literal mapping would create one WorkManager request per worker (~8), each
booting a fresh JS context — 30+ boots an hour. The Android adapter instead
collapses all `schedulePeriodic` calls into a single tick at the minimum
interval, and the headless task calls `runAllNow()`. Because WorkManager's
floor is 15 minutes and every worker interval is ≥15 minutes, this is
behaviourally equivalent and far cheaper. `scheduleOneShot` (retry backoff)
maps 1:1 to `OneTimeWorkRequest`.

The `Scheduler` interface is **unchanged** — coalescing is an implementation
detail of the Android adapter, so `@cemp/sync` stays platform-neutral and the
iOS mapping recorded in `docs/architecture/ios-prep.md` still holds.

## Architecture

```
WorkManager PeriodicWorkRequest  (15-min floor, NetworkType.CONNECTED)
  └─ CempSyncWorker (Kotlin)
      └─ HeadlessJsTaskService  →  backgroundSync()  [TypeScript]
           ├─ vault unlocked?  → messaging.syncNow()        (full engine)
           └─ locked / cold    → notifyOnlyProbe()
                                  ├─ read keystore-cached route tags
                                  ├─ findMessageCells(tag), each cached epoch
                                  ├─ diff outpoints against lastSeen
                                  └─ post one notification
```

## Components

### Native (Kotlin)

Thin adapters only; no protocol logic.

- `CempSyncWorker` — WorkManager worker; starts the headless JS task.
- `CempSchedulerModule` — React Native module exposing `schedulePeriodic`,
  `scheduleOneShot`, `cancel`, backed by WorkManager. Implements the D4
  coalescing.
- `CempNotifierModule` — creates the notification channel; exposes `post` and
  `cancel`.
- Registration in `MainApplication`.

### TypeScript platform seams

New files in `apps/android/src/platform/`, following the existing
`android-keystore` / `native-kdf` / `sqlcipher-adapter` pattern:

- `work-manager-scheduler.ts` — implements `Scheduler`; replaces
  `InMemoryScheduler` in the app.
- `android-notifier.ts` — implements `Notifier`; replaces `NoopNotifier`.
- `route-tag-cache.ts` — keystore-wrapped `{ tags, lastSeen }` accessor.

### Background entry

`apps/android/src/background-sync.ts`, registered with
`AppRegistry.registerHeadlessTask` in `index.js`. Contains only the
locked/unlocked branch — no protocol logic.

### Wiring

`AppContainer` installs the real scheduler and notifier. `afterVaultUnlock()`
refreshes the route-tag cache; this is the only place tags are written, because
deriving them requires the profile id.

No changes to `@cemp/sync` or `@cemp/ckb`.

## Data flow

**On unlock** (`afterVaultUnlock`):

1. Derive route tags for previous, current and next epoch.
2. Write the keystore-wrapped `{ tags, lastSeen }`.
3. Start the engine, which schedules the coalesced tick.

**On each background tick:**

- _Vault unlocked_ → `messaging.syncNow()`, then refresh the route-tag cache.
  Refreshing here as well as on unlock matters: a session that stays unlocked
  across an epoch boundary would otherwise leave stale tags behind for the next
  locked probe. Per-message notifications come for free — the discovery worker
  already calls `notifier.post`, it was simply landing in `NoopNotifier`.
- _Locked or cold start_ → notify-only probe:
  1. Read cached tags; if absent (never unlocked since install), no-op.
  2. `findMessageCells(tag)` for each cached epoch — cursorless full scan, per
     the 2026-07-19 discovery fix.
  3. Diff returned outpoints against `lastSeen`.
  4. If anything is new, post one notification: "N new messages — unlock to
     read".
  5. Overwrite `lastSeen` with the current set.

The probe never decrypts and never opens the database. On the next unlock the
full sync ingests the messages properly and per-message notifications resume.

## Failure modes

- **Notification permission** (Android 13+ `POST_NOTIFICATIONS`) — requested on
  first unlock, non-blocking. If denied, sync still runs; notifications are
  dropped.
- **`lastSeen` growth** — overwritten each run rather than appended, so it is
  bounded by inbox size.
- **Repeat notifications** — a stable notification id means a re-notify
  replaces rather than stacks.
- **Network/RPC failure in the probe** — swallowed; WorkManager's retry policy
  and the existing backoff one-shot cover it.
- **Process killed mid-tick** — WorkManager reschedules; every worker is
  idempotent.
- **Doze** — the OS defers ticks. An honest limitation, documented in the same
  spirit as the iOS mapping.
- **Epoch rollover while locked** — mitigated by caching the next epoch's tag;
  beyond that window the probe goes quiet until the next unlock.

## Testing

- **TypeScript unit** — `backgroundSync()` branch logic against a fake vault
  state, notifier and chain: unlocked runs the full sync; locked runs the probe
  only and never touches the database; the dedup marker suppresses a repeat
  notification; missing or stale tags no-op.
- **TypeScript unit** — route-tag cache round-trip; scheduler coalescing (N
  `schedulePeriodic` calls produce one native periodic request at the minimum
  interval; `scheduleOneShot` maps 1:1; `cancel` propagates).
- **Native** — deliberately thin adapters, verified on-device rather than
  unit-tested.
- **On-device (the real gate)** — background the app and confirm a message
  arrives unaided; then lock it, send from the second device, and confirm the
  notification appears with nothing decrypted.

## Exit criteria

| Spec criterion                                 | Status under this design                                      |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Messages discovered after backgrounding        | Met while unlocked; notify-only when locked (deviation below) |
| Reboot does not lose scheduled work            | Met — WorkManager persists work across reboot                 |
| Duplicate workers don't double-respond/reclaim | Already met by the existing outpoint and reclaim leases       |

## Deliberate limitations

- **Locked delivery is a notification, not a message.** Content arrives on
  unlock. This follows directly from D1 and is the price of keeping the
  database encrypted at rest.
- **Doze defers ticks.** Latency is best-effort, not guaranteed.
- **Silent push is out of scope**, as for iOS: it would introduce a central
  service as a protocol dependency (AGENTS.md rule 10).

## Out of scope

Honouring `receipt_request: 0`, and making the auto-lock interval configurable.
Both are real gaps recorded in the README, but neither belongs in this change.
