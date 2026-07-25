# Android image messaging — progress ledger

Plan: docs/superpowers/plans/2026-07-25-android-image-messaging.md
Branch: feat/android-image-messaging (off main @ b9d0152)

## Pre-flight
Plan self-reviewed clean (one undefined constant fixed pre-execution). Known
implementer-resolvable soft spots flagged in-plan (test harness/fixtures in
Tasks 3,12,13,15; app accessors in 13,15) — notes provided, not contradictions.

## Completed tasks
(none yet)

Task 1: complete (commits b9d0152..4255d76, review clean — spec ✅, quality Approved)
Minor findings carried to final review:
- attachment-key.test.ts: only 2 cases (coordination round-trip + wrong-len kemMessage);
  wrong-len nonce/pubkey/profileIds and the encapsulate catch-branch untested (from brief).
- attachment-key.ts:132 hardcodes profile-id length 32 (envelope.ts's PROFILE_ID_BYTES is
  private/unexported) — magic number duplicated across two files.
NOTE: correct test invocation is `npx vitest run <path>` from REPO ROOT (config is
root-only with root-relative globs); the plan's `cd <pkg> && npx vitest` form fails.

Task 2: complete (commits 4255d76..a086e05, review clean — spec ✅, quality Approved)
- Reviewer ⚠️ lockfile completeness — RESOLVED by controller: `pnpm install --frozen-lockfile` succeeds.
- @noble/post-quantum added as DEV dependency to cemp-ckb (test-only; pnpm doesn't hoist).
Minor findings carried to final review:
- EncryptEnvelopeTestOverrides (envelope.ts:52) now carries a PRODUCTION path (attachmentEnvelope
  routes through it) despite its "test-only" name — rename/redocument so future auditors don't
  skip its production callers. Pre-existing name, out of Task 2 scope. DECISION for final review.
OPERATIONAL: dependent packages import a dependency's built dist/, so rebuild a changed package
(`pnpm --filter @cemp/<pkg> build`) before testing packages that consume it.

Task 3: complete (commits a086e05..64187a7, review clean — spec ✅, quality Approved)
- Reviewer verified mutant-kill: removing the forwarding spread fails the test.
- vi.mock factory vars must be `mock`-prefixed (Vitest 4 hoisting) — operational note.
Minor carried to final review:
- No runtime gate ties attachmentEnvelope to contentType 0x03 (doc-comment only in both
  assemble.ts and publisher.ts). Deferred to Task 4 orchestration boundary — REMINDER added there.

Task 4: complete (commits 64187a7..32d382a, review clean — spec ✅, quality Approved) *** KEYSTONE ***
- §6 coordination PROVEN load-bearing: real assemble→decryptEnvelope→decryptAttachment + wrong-key
  negative control. Wipe-after-resolve SAFE in production (finally can't preempt the pending await).
- 0x03 + attachmentEnvelope structurally paired; @cemp/ckb imports type-only (no cycle).
- @noble/post-quantum added as DEV dep to @cemp/images (test-only). test-helpers.ts extracted (DRY).
Minor carried to final review / Task 13:
- publishText MUST consume/serialize kemMessage+nonce before resolving (already true: Task 3's
  publishText consumes synchronously mid-body) — verify in Task 13 that the real path holds.

Task 5: complete (commits 32d382a..c9852c3, review clean after 1 fix pass — spec ✅, quality Approved)
- Important (FIXED c9852c3): CONSERVATIVE_PER_CHUNK_SHANNON now derives from ATTACHMENT_CHUNK_BYTES
  (was hardcoded 32_768n) — closes the silent-drift risk to the "never under-estimate" invariant.
  Fix verified by controller (import + derived constant present; capacity 3/3 + suite 14/14 green).
Minor carried to final review:
- CONSERVATIVE_MESSAGE_CELL_SHANNON bound (32768+4096) asserted only by docstring, no test; brief
  defers refinement to Task 13.
- Test 1 expected value uses same arithmetic shape as impl (not an independent oracle) — trivial formula.

Task 6: IN PROGRESS. Controller-directed test-strategy deviation from the plan:
- Plan used vi.mock("react-native"); repo has NO RN test-mock infra and by convention does
  NOT unit-test NativeModules-touching bridge adapters (native-kdf.ts, android-notifier.ts are
  untested/device-verified) — it tests only extracted RN-free logic (route-tag-cache-core, etc).
- Directed: build BOTH classes as specced, but unit-test ONLY HandleTracker against a PURE FAKE
  ReleasableImageCodec (no react-native). NativeImageCodec = thin device/compile-verified bridge.
  HandleTracker wraps the interface (ReleasableImageCodec = ImageCodec & {release}) so Task 13's
  `new HandleTracker(new NativeImageCodec())` still holds. Reviewer informed to expect this.

Task 6: complete (commits c9852c3..8f267cd, review clean — spec ✅, quality Approved)
- Two approved deviations (test-strategy: HandleTracker via pure fake; file-split: handle-tracker.ts
  RN-free, re-exported from native-image-codec.ts). Aliasing test confirmed load-bearing by reviewer.
- LESSON (applies to all Android tasks): a vitest test file must NOT transitively import react-native
  (Flow entrypoint crashes the parser) — extract RN-free logic into its own file to test it.
Minor carried to final review:
- native-image-codec.ts imports "./hex.js" (ext) vs native-kdf.ts "./hex" (no ext) — cosmetic.
- releaseAll() swallows release errors (deliberate best-effort, from brief; documented inline).

Task 7: complete (commits 8f267cd..ea34431, review clean — spec ✅, quality Approved)
- RN-free split reused: decodePickResult (pure, tested: cancel→null + hex→bytes); pickImage thin bridge.
Minor carried to final review: one test name could be more precise (trivial).

Task 8: complete (commits ea34431..f70abc2, review clean after 1 fix pass — spec ✅, quality Approved)
- Added exifinterface dep; :app:compileDebugKotlin BUILD SUCCESSFUL (verified --rerun).
- Important FIXED (f70abc2): resize() handle-aliasing use-after-recycle (createScaledBitmap identity
  return) — now defensive-copies when scaled===src. Verified.
- Also fixed: EXIF TRANSPOSE/TRANSVERSE cases; hexToBytes fail-fast (matches KDF idiom); release() comment.
- Metadata-strip invariant holds unconditionally (Bitmap has no EXIF channel). Registry thread-safe.
Minor carried to final review: none outstanding (all bundled into the fix).

Task 9: complete (commits f70abc2..7a09665, review clean after 1 fix pass — spec ✅, quality Approved)
- CempImagePicker + CempImagePackage + activity-ktx dep + MainApplication registration.
  :app:compileDebugKotlin BUILD SUCCESSFUL (--rerun-tasks). Two compile-driven adaptations:
  reactApplicationContext.currentActivity; onNewIntent(Intent) non-null.
- Important FIXED (7a09665): pending Promise now AtomicReference<Promise?> (getAndSet/compareAndSet)
  — closes cross-thread JMM visibility race; resolver decoupled to reactApplicationContext. Verified.
Minor carried to final review:
- overlapping picks share the constant REQUEST_CODE 0xC0DE (edge case; brief's "new rejects prior" holds).
- non-Exception Throwables lose cause in reject (consistent w/ CempImageCodecModule.asException style).
*** NATIVE LAYER (Tasks 6-9) COMPLETE: JS adapters + Kotlin codec + picker + registration, all compile-gated. ***

Task 10: complete (commits 7a09665..53d467b, review clean — spec ✅, quality Approved, no issues)
- OutgoingTxJournalAdapter: pure delegation; markState patch-object mapping exact. Real DB round-trip test.
- Import NodeSqliteAdapter from "@cemp/database/node" subpath (brief said "@cemp/database").

Task 11: complete (commits 53d467b..8e41cb4, review clean — spec ✅, quality Approved, no issues)
- attachments field REQUIRED on SyncWorkerDeps; 2 construction sites updated (messaging.ts + workers.test.ts
  makeStack). @cemp/sync rebuilt; tsc clean both; vitest 26/26.

Task 12: complete (commits 8e41cb4..020398d, review clean — spec ✅, quality Approved)
- GOOD CATCH: plan's literal persist branch duplicated the attachment row every cursorless re-scan;
  fixed with check-before-create guard (listForMessage length===0), proven by a double-run regression
  test through the real engine seam. Robust under serialized single-worker model.
Minor carried to final review:
- Guard is "any row exists → skip whole loop", not per-manifest: a >1-manifest message that crashes
  mid-loop wouldn't heal manifest[1..] (UNREACHABLE today — senders only emit [manifest] singleton).
- No DB-level UNIQUE(message_id,...) backing the app-level guard (known follow-up).

Task 13: complete (commits 020398d..5bea7e0, review clean — spec ✅, quality Approved, no crit/imp)
- runImageSend: actual-size pre-flight (estimateAttachmentCapacity off compressed bytes, NOT max),
  blocks BEFORE publish (spy-asserted); jargon-free too-large + insufficient-balance messages.
- ONE HandleTracker instance shared across pre-flight prepare + publishImageMessage; single finally
  releaseAll covers both (no leak). Balance accessor: BalanceRepository.getBalance(walletId).availableShannon.
- ADAPTATION: createImageCodec factory injected at init (app-container supplies () => new NativeImageCodec());
  messaging.ts has NO NativeImageCodec import so messaging.test.ts still runs. Clear throw if factory omitted.
- Recipient KEM key + profileId are CALLER-SUPPLIED to publishImage → Task 15 must resolve them.
Minor carried to final review: double prepareImage per send (accepted perf); no assertion pinning the
  factory-omitted clear-throw.

Task 14: complete (commits 5bea7e0..bc69f90, review clean — spec ✅, quality Approved, no issues)
- imageBubbleState pure state machine; 7A error keeps thumbnail + tap-to-retry (non-terminal). Full-object tests.

Task 15: SPLIT by controller into 15a (MessagingService methods) + 15b (chat-screen/composer UI glue).
  Rationale: the plan folded two non-trivial service-layer prerequisites into Task 15's implementer notes —
  (1) publishImage must resolve the recipient's KEM pubkey from chain (belongs in publishImage, has #client,
  mirrors publishText); (2) deriveIncomingAttachmentKey (re-fetch cell -> decryptEnvelope -> attachmentKey,
  since the key is never stored). Splitting keeps those reviewable instead of hidden behind device-verified glue.

Task 15a: implementer failed once on session-usage-limit (no commits/no changes lost); retry succeeded.

Task 15a: complete (commits bc69f90..f36d57b, review clean — spec ✅, quality Approved, no crit/imp)
- publishImage resolves recipient internally (resolveLiveProfile + checkResolvedProfileBinding, byte-mirror
  of publishText); input dropped caller-supplied KEM key/profileId. deriveIncomingAttachmentKey: getChainRef
  -> getLiveCell -> decryptEnvelope -> attachmentKey (never persisted). Reuses #bundle.mlKem.secretKey/#senderProfileId.
- Receive-side key round-trip test PROVES agreement (== deriveSendAttachmentKey), verified load-bearing by
  reviewer tracing the crypto. (One earlier run died on session-limit; retry succeeded, nothing lost.)
Minor carried to final review: 0x-strip-before-hexToBytes duplicated 3x (shared helper later); prototype-patch
  test fixture (theoretical leakage, restored in finally; revisit if init() gains client injection).

Task 15b: complete (commits f36d57b..2346482, review clean — spec ✅, quality Approved, no crit/imp)
- bytesToBase64 (verified correct vs known vectors + Buffer oracle); downloadImageAttachment wipes key in
  finally (centralized secret lifecycle); insertImageDraft mirrors send(); 7A loadFull never crashes render;
  cancel=no-op. No RN import in messaging.ts. apps/android 99/99, cemp-ui 13/13, tsc clean.
Minor carried to final review: reload() N listForMessage queries; fixed 200x200 bubble (no aspect ratio);
  attachImage no double-tap guard (same as text send).
*** NOTABLE for final review / USER DECISION: IMAGE SENDS NOT RETRYABLE ON PUBLISH FAILURE. insertImageDraft
  persists body:null; compressed bytes are in-memory only — if publishImage throws post-insert, the row is
  stuck "queued"/"sending" with nothing for a retry worker to resend (text persists its body and self-heals).
  Inherited from Task 13 publishImage design. Fix options: persist compressed bytes for retry, OR mark row
  failed with a UI retry affordance. NOT blocking the round-trip milestone but a real pre-ship gap. ***

*** ALL 15 IMPLEMENTATION TASKS COMPLETE. Remaining: Task 16 (integration gate) + Task 17 (on-device). ***

Task 16: complete (no commit — all gates green first run). pnpm -r build 12 pkgs; vitest 594 passed/1
skipped; tsc clean; compileDebugKotlin BUILD SUCCESSFUL; assembleDebug APK (188MB) at
apps/android/android/app/build/outputs/apk/debug/app-debug.apk.

FINAL WHOLE-BRANCH REVIEW (opus, b9d0152..2346482, 19 commits): Ready to merge WITH FIXES.
No Critical. §6 coordination confirmed sound end-to-end; metadata-strip holds by construction;
secret hygiene good; receive-side validation not bypassed; discovery idempotent.
IMPORTANT (fix before merge):
  I-1 (spec violation): attachImage inserts draft row BEFORE validation -> too-large/decode/capacity/
      no-messaging strand a permanent "sending" ghost. Fix: guard preconditions before insert + mark row
      `failed` on any failure. (Downgrades the image-retry gap to acceptable follow-up.)
  I-2 (docs only): EncryptEnvelopeTestOverrides docstring forbids production use, but §6 routes prod
      traffic through it. Reconcile docstring to legitimize seam under fresh-CSPRNG-per-message invariant + xref §6.
Acceptable FOLLOW-UPS (post-milestone): image-send retry persistence; checkManifest at discovery for the
  pre-download thumbnail; UNIQUE(message_id) backing + per-manifest guard; 0x-strip shared helper; prototype-
  patch test fixture; double prepareImage; reload N-queries; fixed 200x200 bubble; attach double-tap guard;
  bridge-doc path drift (native-image-codec cites com/cempmobile/images, picker cites .../picker; actual imaging).

FINAL-REVIEW FIX PASS: complete (commit d744d58, verified by controller).
- I-1 FIXED: attachImage guards !hasMessaging/no-profileId BEFORE insert (no row); marks row `failed`
  (MessageRepository.transitionState, queued->failed legal) on any catch -> no stranded "sending" ghost.
- I-2 FIXED: EncryptEnvelopeTestOverrides docstring reconciled (legitimizes §6 prod seam under fresh-
  CSPRNG-once-per-message invariant; golden-vector note kept; name unchanged).
- Minor: bridge-doc path drift corrected to com/cempmobile/imaging.
Verify: tsc -p apps/android clean; apps/android vitest 99; cemp-crypto vitest 72.
BRANCH CODE-READY. Remaining: Task 17 on-device acceptance gate (user-run; runbook committed a4f8ef6).

MERGED to main (--no-ff, merge commit e0bf787) 2026-07-25. Tests green on merged result
(594 passed/1 skipped). Feature branch deleted (was d744d58). Normal repo, no worktree cleanup.
NOT pushed (user did not request). Remaining: Task 17 on-device acceptance gate (user-run).

Task 17: on-device acceptance gate — PASSED WITH FINDINGS (2026-07-25, Kimi session).
Devices: Samsung R5CTC07MPYD (sender, ~95.5k CKB avail), Retroid JY202406200301173 (receiver).
- 1-2. APK (6c1a179 + Metro import fix 1955ee4) installed both; profiles confirmed:
  Samsung b6d36766…f73331, Retroid b2cf960…05e019.
- 3. Probe image: synthetic 640x480 JPEG, 18,554 B, EXIF Make/Model/Orientation=6/GPS(S 34°55'30"
  E 138°36')/UserComment marker. First send FAILED (see F-1); fresh send succeeded:
  chunk tx 0xd14baec7…864b (6,184 B ciphertext cell, 1 chunk) committed; message tx
  0x9dc840d5…24d5 (4,169 B envelope+manifest, CEMP type) committed 3 blocks later.
  Bubble: thumbnail immediate, queued → sent.
- 4. Retroid: thumbnail rendered immediately from manifest; tap → spinner → full-res renders,
  orientation baked into pixels (EXIF-6 source displays rotated correctly).
- 5. EXIF-strip proof: on-chain chunk cell + message cell scanned — ZERO EXIF/GPS/JPEG/WebP/
  string markers, entropy ~7.95 bits/byte (pure ciphertext). Receiver persists no plaintext
  (rule 3): Fresco disk cache held only app icons; runbook's "pull rendered file" step is N/A
  by design — proof is on-chain ciphertext + pixels-only reconstruction.
- 6. Reclaim: Retroid auto-acked (bubble → read); message cell 0x9dc840d5:0 RECLAIMED (spent).
  CHUNK CELL NOT RECLAIMED — see F-2.
FINDINGS (pre-ship):
- F-1 (Important): stale cell selection built the chunk tx over an already-spent input
  (0x821ee3be…:0) → node rejected "Resolve failed Unknown(OutPoint)". Worse: the retry path
  republishes the SAME attachmentId → same journal purpose → resumeJournaledBroadcast keeps
  rebroadcasting the permanently-invalid tx (JournaledAbandonedError propagates, no abandon+
  requeue in publishAttachmentChunks, unlike the message/reclaim paths). The failed row is
  wedged; only a fresh send recovers. Fix: abandon+requeue (fresh attachmentId/inputs) on
  JournaledAbandonedError in the attachment-chunk path + investigate why a spent cell was
  selected (indexer lag vs trackBroadcastSpend gap).
- F-2 (Important): reclaimAttachmentGroup has NO production caller (only tests) — chunk cells
  are never reclaimed; 6,263 CKB from this send remains locked on-chain. Spec §4 item 4
  assumed it was wired. Fix: call it from the reclaim lifecycle for rows with attachments.
- F-3 (Minor, fixed in-session): Metro 0.83 doesn't resolve NodeNext ".js"-suffixed relative
  imports used by the image-branch files; T16 gates (tsc/vitest/assembleDebug) never exercised
  a Metro bundle. Fixed extensionless (1955ee4); on-device bundle gate now part of T16-lessons.
- F-4 (UX note): dev-mode LogBox overlay surfaces any console.error full-screen on device.
