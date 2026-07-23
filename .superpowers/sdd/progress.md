# Phase 9 background operation — progress ledger

Plan: docs/superpowers/plans/2026-07-20-phase9-background-operation.md
Branch: feat/phase9-background-operation (off main @ 5660e5a)

## Pre-flight corrections applied to the plan

- Task 7: locked probe must build its own CempClient (no vault) instead of
  routing through MessagingService — otherwise a cold start can never notify.
- Task 7: extract the duplicated "read cache -> derive tags -> write cache"
  into one shared helper.

## Completed tasks

Task 1: complete (commits 1a82661..5e31b17, review clean — spec ✅, quality Approved)
Minor findings carried to final review:

- decodeTagCache silently drops unknown top-level keys; given the cache must
  hold ONLY tags/outpoints, rejecting unexpected fields would detect a bad writer
- JSON.parse SyntaxError vs custom "route-tag-cache:" Error — inconsistent error surface
- untested branches: lastSeen wrong-type, extra keys surviving, duplicates in `current`
- TextDecoder not { fatal: true }
  Task 2: complete (commits 5e31b17..4ce0cd9, review clean — spec ✅, quality Approved)
  Reviewer ⚠️ "is coalesce wired in?" — resolved by controller: consumed by Task 4
  (work-manager-scheduler.ts), not yet executed. Not a gap.
  Minor findings carried to final review:
- no test where floor-clamping and shortest-interval selection interact
- no test for 3+ specs, duplicate intervals, or degenerate values (0/negative/NaN)
  Task 3: complete (commits 4ce0cd9..ae1285d, review clean after 2 fix passes)
- Plan amended twice (approved by human): notify-before-record; carry forward
  unanswered tags' lastSeen instead of overwriting wholesale.
- Minor carried forward: full-answer branch writes `current` without dedup
  while the partial branch dedups via Set — inert today because newOutpoints
  only does Set-membership on lastSeen. Flag to final review.
  Task 4: complete (commits ae1285d..7e2a908, review clean after 1 fix pass)
- Plan amended (approved by human): lazy native-module lookup matching
  native-kdf.ts; periodic-spec bookkeeping extracted to SpecRegistry in the
  RN-free scheduler-coalesce.ts so it is unit-testable.
- Minor carried forward: schedulePeriodic's `if (tick === undefined) return`
  is an always-dead guard (add() can never yield an empty map). Pre-existing.
- Minor carried forward: cancel() cannot stop periodic participation (fixed
  "cemp-sync-tick" work name); documented, unreachable today. Flag to final review.
  Task 5: complete (commits 7e2a908..20f0a4f, review Approved first pass, spec OK)
- Justified deviation: added VISIBILITY_PRIVATE + generic setPublicVersion to
  CempNotifierModule.kt. workers.ts posts contact.displayName as title and a
  truncated message preview as body — confirmed live, a real lock-screen leak.
- IMPORTANT follow-up (raised with human): VISIBILITY_PRIVATE only redacts if
  the DEVICE's "hide sensitive content" setting is on, which is not the default
  on stock AOSP or most OEM skins. Also no setLocalOnly(true), so notifications
  mirror to paired Wear OS devices, bypassing phone-side redaction entirely.
- Minor carried forward (both inherited from plan, not implementer):
  NotificationChannel display name reuses the raw channel id; id.hashCode()
  gives a 32-bit collision space for notification ids.
  Task 5b: complete (commit 46c4c95, security review Approved) — ADDED, not in plan.
- Notifications are now generic always ("CellSend" / "New message. Unlock to
  view.") — no display name, no message preview. Stable replace-id preserved.
- setLocalOnly(true) added; VISIBILITY_PRIVATE + setPublicVersion retained.
- Reviewer independently re-grepped: one production notifier.post call site;
  id embeds only the local DB row id; tests assert absence of displayName and
  plaintext, so reinstating the preview fails them.
- Minor carried forward: workers.ts comment claims the copy "matches the voice
  of" background-sync-core's locked-probe notification, but no such literal is
  committed yet (it only passes a count). Soften or drop the claim.
  Task 6 + 6b: complete (commits 46c4c95..47876fc, review Approved, no issues)
- CempBackgroundPackage registers CempSchedulerModule + CempNotifierModule via
  the existing Bridgeless PackageList(...).apply pattern in MainApplication.
- Name correspondence independently confirmed both sides: getName() ->
  "CempScheduler"/"CempNotifier" match the NativeModules lookups. Untested by
  any suite — a mismatch would only throw at runtime.
- 6b fixed a BUILD-BREAKING error shipped by Task 4: getTaskConfig(intent:
  Intent) did not match RN 0.83's getTaskConfig(intent: Intent?). Widened.
- *** A working Gradle/Android toolchain IS available in this environment. ***
  Earlier tasks wrongly assumed none existed and judged Kotlin by reading,
  which is how the compile error survived two reviews. Every later task MUST
  run :app:compileDebugKotlin and :app:assembleDebug.
- Reviewer reproduced both Gradle commands non-cached: compile clean, APK built.
- Minor carried forward: createViewManagers override is deprecated in both
  CempBackgroundPackage and the pre-existing CempKdfPackage.
  Task 7: complete (commits 47876fc..2630d57, review Approved after 2 fix passes)
  Opus review found 2 CRITICAL + 4 Important; all closed and mutation-verified.
- C1: route-tag cache survived factory wipe fully readable (pointer blob lived
  in AsyncStorage OUTSIDE the vault; deleteKey() reset only the default
  keychain service). Fixed: RouteTagCache.clear() from wipe() + cancel the
  periodic tick. Reviewer confirmed against react-native-keychain 10.0.0 source.
- C2: wrap() minted a fresh random service id per call and the locked path
  wraps EVERY tick -> one orphaned route-tag keychain entry per tick. Fixed
  with a stable service id cemp.rt.v1 (overwrites in place; the randomness
  bought nothing since the pointer sits in plaintext AsyncStorage).
- I1: locked probe read only the first page (limit 64, asc) and discarded the
  cursor -> a tag went permanently dark past 64 cells while still counting as
  answered. Now paginates to exhaustion using workers.ts's loop, breaking on
  the terminal "0x" (the 2026-07-19 cursor-poison). Mutation-verified.
- I2 silent no-op on missing messaging; I3 stranded/duplicated hex helpers
  (now genuinely one copy repo-wide); I4 security-property tests.
- N1/N2 follow-ups closed: the "WorkManager retries with backoff" comment was
  false (doWork returns success once the service starts, and RN only notifies
  for HeadlessJsTaskError) — comment corrected and the 120s service linger
  fixed; bestEffort() stops cancel rejections escaping wipe().
- Minor carried forward: hexToBytes silently truncates odd-length input
  (pre-existing, inherited from all three prior copies); no edge-case tests for
  odd-length/uppercase/0x-prefixed hex.
- Minor carried forward: no automatic recovery for a persistently-degraded
  messaging init — the only signal is a console log.
- PRE-EXISTING RESIDUE: devices that ran the earlier Phase 9 build hold
  orphaned cemp.ks.<random> entries with route tags from every prior tick.
  Service ids unrecoverable — clears only on uninstall. No retroactive fix.
  Task 8: ON-DEVICE VERIFICATION — in progress (commits 2630d57..95d0292)
  PROVEN on device (Samsung R5CTC07MPYD + Retroid JY202406200301173, testnet):
- Exactly ONE WorkManager job enqueued (CempSyncWorker / "cemp-sync-tick"),
  confirming the 8-worker coalescing collapses to a single tick.
- POST_NOTIFICATIONS runtime prompt fires on first unlock.
- BACKGROUND DELIVERY WHILE UNLOCKED: message arrived and a notification was
  posted with the app backgrounded (topResumedActivity = launcher), twice
  (16:12:47 and 16:18:44). "phase9-tick-proof" confirmed in the conversation.
- NOTIFICATION LEAK FIX VERIFIED LIVE: title "CellSend", body "New message.
  Unlock to view.", vis=PRIVATE, publicVersion "New activity". No contact
  name, no message preview.

NOT YET PROVEN: locked notify-only. No tick has been observed taking the
locked branch.

BUGS FOUND ON DEVICE THAT 522 GREEN TESTS MISSED (all fixed):

1. a8bfea2 — SyncEngine.start() was called NOWHERE in the app. It is the only
   caller of schedulePeriodic. Tests each called start() themselves, so
   nothing had ever been scheduled. Phase 9's whole point was inert.
2. e3bbcc0 — "cannot start a transaction within a transaction". Both DB
   adapters checked #inTransaction BEFORE awaiting BEGIN, so two concurrent
   callers both passed the guard. Nothing was concurrent until the tick fired.
   The regression test also exposed a latent data-integrity bug: a FAILED
   transaction's write rode along with an unrelated commit.
3. 433764d — "Background start not allowed". CempSyncWorker used
   startService(), forbidden from background since API 26; a periodic worker
   is ALWAYS background, so catch(IllegalStateException)->retry could never
   succeed. Reworked (human-approved) to run JS via ReactHost, no Service.
4. 47876fc — CempSyncTaskService.kt did not compile (getTaskConfig signature).
   Survived two reviews that took "no Gradle toolchain" at face value.

TESTING LEVER LEARNED: `cmd jobscheduler run -f` does NOT force periodic
WorkManager work. Logcat states it plainly:
"Delaying execution ... because it is being executed before schedule."
"Status is ENQUEUED; not doing any work and rescheduling for later"
Also every unlock calls engine.start() -> re-enqueues the periodic work, which
appears to push the next execution out. Frequent unlocking defers the tick.
INVESTIGATE: whether repeated UPDATE re-enqueues can starve background sync
for a user who opens the app often. Test by leaving the device untouched.

Instrumentation added (95d0292): grep logcat for "CempSync" (native tag) and
"[CempSync]" (JS, via ReactNativeJS). Counts and outcomes only, never content,
route tags, profile ids or outpoints.

Task 8: COMPLETE — all exit criteria proven on device (2026-07-20).
LOCKED NOTIFY-ONLY PROVEN (19:08 tick trace + 18:51 notification):
"vault seen as locked; taking the locked-probe branch"
"read 3 cached route tag(s)" <- prev/current/next epoch (D2)
"page 1 returned 8 cell(s)" / "page 2 returned 0" <- I1 pagination fix LIVE
"tag 1/3, 2/3, 3/3 answered" <- per-tag isolation
outcome=quiet tagsRead=3 tagsAnswered=3 outpointsSeen=8
Notification posted 18:51:14, vault locked + app backgrounded:
title "CellSend", text "8 new messages - unlock to read",
publicVersion "New activity". Distinct from the unlocked copy
("New message. Unlock to view."). No DB open, no decrypt.
The following 19:08 tick returned quiet with NO duplicate notification,
proving lastSeen is recorded and honoured across ticks.

TWO FINDINGS STILL OPEN (not blocking the criteria, but real):

1. Auto-lock can close the database underneath an in-flight background sync:
   18:34:13 "full sync: starting" -> 18:34:46 "degraded tick - the database
   connection is closed". Fails loudly and retries, but AppContainer tears
   down the DB before/while a tick is mid-run. Consider gating teardown on
   an in-flight tick, or having the tick re-check state before each stage.
2. The 120s headless linger is NOT fixed by the N1 boundary catch:
   error at 18:34:46, but "runTask: headless task id=2 finished" only at
   18:36:13 - exactly TASK_TIMEOUT_MS later. A degraded tick still holds the
   RN runtime for two minutes.

TESTING NOTE FOR FUTURE RUNS: verify every UI step against `uiautomator dump`
bounds rather than firing fixed coordinates. Blind taps cost three cycles this
session (keyboard swallowed SEND; password typed into a stale field; a
"Settings" tap that launched the Clock app and invalidated a locked test).

FINAL REVIEW + POST-REVIEW FIXES (commits 95d0292..3db150c)
Opus whole-branch review: no Criticals, "merge after fixes". All applied:

- 8108f9e auto-lock could PERMANENTLY strand an incoming message.
  processDiscoveredCell walks 3 separate transactions; a DB close between them
  left the row at downloading/decrypting, and insert()'s ON CONFLICT DO NOTHING
  - re-read meant the `state === "discovered"` guard then skipped it forever —
    never notified, never auto-acked, so the SENDER hung at "sent" too. Fixed
    both ways: close() waits on the tx mutex; healer extended to incoming states.
- 3072a3a debug logs could emit an outpoint via error.message (CempCkbError is
  built from an 80-char preview of RPC data; a tx hash is 66 chars).
- 16b10cb console stripping for release. NEARLY SHIPPED BROKEN: the RN-documented
  env:{production} block is INERT because Metro loads babel.config.js via
  Babel's `extends`, and minification independently strips most console calls,
  so a minified bundle looks correct either way. Working form is the function
  config gated on api.env("production"), proven by diffing UNMINIFIED bundles.
- ac78418 tick no longer resets its own period on every unlock (KEEP, with
  UPDATE only when interval/network actually change). Verified on device:
  Minimum latency identical to the ms across 3 unlocks incl. one running
  engine.start(), and the WorkSpec id never changed all session.
- 173ffe1 lock() now locks the vault BEFORE closing the DB — the one path where
  the new unbounded close() wait could hold the vault open on a driver hang.

TWO MORE DEVICE-ONLY BUGS FOUND AND FIXED AFTER THE REVIEW:

- 908f5f2 EVERY tick held the RN runtime for the full 120s timeout, not just
  degraded ones (measured on a SUCCESSFUL tick: 6s of work, finish at +120.0s).
  Root cause: HeadlessJsTaskSupportModule is NOT registered in RN 0.83.10's
  bridgeless CoreReactPackage — nothing instantiates it — so
  TurboModuleRegistry.get returns null, both guards in AppRegistryImpl fall
  through, notifyTaskFinished is never called, and only the timeout ends a
  tick. Fixed with our own JS->native finish signal; timeout kept as backstop.
  VERIFIED: 19ms instead of 113.955s.
- 3db150c the tick branched on AppContainer's CACHED state, which is maintained
  by a 1s setInterval that RN freezes while backgrounded — so a tick took the
  full-sync branch on a vault locked 7 minutes earlier, then died on a DB the
  resumed poll closed mid-sync. NOTE the correction to the first diagnosis:
  the vault's OWN auto-lock is also a setTimeout and is frozen too, so
  consulting vault.state alone would NOT have fixed it. Fix gates on a
  wall-clock autoLockDeadlineMs. touch() deliberately avoided — it restarts the
  inactivity window and would keep a backgrounded vault unlocked forever.
  VERIFIED: tick 10min after auto-lock took the locked-probe branch, whole
  tick 1.55s end to end.

FINAL STATE: 30 commits, 556 tests + 1 skipped, Kotlin compiles, APK assembles.
All three Phase 9 exit criteria proven on hardware.

FOLLOW-UPS (2026-07-22):

- DONE (bf88a5e): stale intervalMs across upgrade. Instead of versioning the
  unique work name (which would orphan the old WorkSpec unless separately
  cancelled), CempSchedulerModule now persists a SCHEDULE_VERSION in
  SharedPreferences; a mismatch forces ExistingPeriodicWorkPolicy.UPDATE once
  after an upgrade, then KEEP-across-unlock resumes. Bump SCHEDULE_VERSION when
  a release changes the tick interval/constraint. Kotlin compiles.
- DONE (161d196): healStrandedIncoming now wraps each row in try/catch, matching
  the discovery loop. Regression test: first-of-two stranded rows throws at the
  notification post, second still heals+acks, worker still succeeds.
- OPEN (env, not code): Retroid wallet is capacity-bound — 9,999 CKB total, only
  ~4,512 available (rest locked in CEMP protocol cells). Top up via faucet, swap
  a fresh test wallet, or keep on-device send amounts within available balance.

ON-DEVICE E2E ON HEAD (2026-07-23): Samsung → Retroid, HEAD-vs-HEAD.
Both devices reinstalled with the HEAD debug APK (carries the Kotlin WorkManager
schedule-version gate bf88a5e); JS served by Metro from the current dist (carries
the healStrandedIncoming fix 161d196). Metro ran on :8082 — host :8081 is held by
an unrelated service — with `adb reverse tcp:8081 tcp:8082` on each device, so no
app-side dev-server config change was needed.

Samsung (unlocked) sent `head-e2e-164337` into the Retroid thread → UI "sent".
Retroid (LOCKED) tick force-run via `cmd jobscheduler run -f com.cempmobile.debug
256`:
vault seen as locked; taking the locked-probe branch <- 3db150c authoritative-state fix
read 3 cached route tag(s) <- prev/current/next epoch
tag 2/3 answered with 8 outpoint(s) <- I1 pagination fix
posting notification for 1 new message(s) <- lastSeen dedup (7 seen + 1 new)
outcome=notified tagsRead=3 tagsAnswered=3 outpointsSeen=8
Tick 16:55:32.283 -> 33.907 = ~1.6s end to end (908f5f2 bridgeless finish signal,
NOT the old 120s linger). No DB open, no decrypt. dumpsys notification confirmed
the LOCKED copy: title "CellSend", text "1 new message — unlock to read",
vis=PRIVATE with a redacted publicVersion — distinct from the unlocked
"New message. Unlock to view." So a HEAD sender's on-chain publish was discovered
and correctly notify-only surfaced by a LOCKED HEAD receiver: every Phase 9 exit
criterion, live, on the current build.

TESTING NOTE: the vault auto-locks on an inactivity deadline, and host-side
parsing gaps between adb taps are enough to trip it (re-locked mid-nav once).
Drive unlock -> navigate -> send as ONE uninterrupted adb burst; do host-side
uiautomator parsing only after the interactive step completes.
