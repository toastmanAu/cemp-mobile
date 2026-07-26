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

F-2 FIXED + device-verified (2026-07-25, commit e81922e): reclaim-batch worker now reclaims
attachment chunk cells (injected group reclaim; scan of outgoing `reclaimed` rows, skip on
committed reclaim-attachment journal, per-group isolation). 598 vitest green (+3 worker
tests). On-device proof: the stranded T17 chunk cell 0xd14baec7…:0 was reclaimed by tx
0xec323840…9860 (committed, block 21864572) on the first unlock after deploying the fix —
6,262.9999 CKB returned to the Samsung wallet (fee-only cost).

F-1 FIXED + device-verified (2026-07-26 local, commits 92575c6 + bd99a87). Refined root
cause (on-chain forensics): attempt 1's CHUNK tx (0xf0f862b5…) committed fine; the MESSAGE
tx build then re-selected an input that chunk tx had just spent — the chunk path never
called trackBroadcastSpend, and the indexer still offered the cell. Node rejected the
message tx; every retry then wedged on resumeJournaledBroadcast (JournaledAbandonedError
propagated; neither the publisher nor the chunk path had abandon+requeue). Retries also
re-uploaded chunks per attempt (4 orphan 6,184B cells ≈ 25k CKB locked in plain no-type
cells — they re-enter the ordinary spendable pool, accepted cost, documented in spec 9A).
Fixes: (1) trackBroadcastSpend on both image broadcast paths; (2) abandon+requeue on
JournaledAbandonedError in publishText AND publishAttachmentChunks (fresh build, same
logical id/purpose; newest journal record wins). 600 vitest green (+1 chunk abandon, +1
publisher abandon-with-resume-of-fresh-tx). On-device: the wedged row retried → sent in
24s; chunk tx 0x3dfd9090… + message tx 0x5bcf7dd6… both committed (blocks 21866022/25).

Retroid pulled the recovered image (2026-07-26 local): discovered on unlock, thumbnail from
manifest, tap → full-res renders with orientation baked — the F-1 recovery is a clean
end-to-end delivery (message tx 0x5bcf7dd6…). The older T17 image bubble correctly shows
"Tap to load" still (its chunks were reclaimed in the F-2 proof; a tap would exercise the
documented 7A graceful-failure path).

## Phase 11 close-out + review-remediation session (2026-07-26)

Prettier sweep (f53085b, CI gate parity; eslint ignores .remember scratch). Trivial minors
(54f8c76: 0x-tolerant hex helper, double-tap guard, aspect-ratio bubble, spyOn fixture).
Small minors (bc619b0: checkManifest at discovery, single prepareImage, batch attachment
lookup, UNIQUE(message_id) migration v7). CHECKLIST refreshed (47a43d4).

DELTA RE-REVIEW (task-16 follow-up, 5-area swarm over the whole image surface + F-1/F-2
deltas): 2 Critical + ~12 Important/Minor found, all triaged and fixed same-session:

- C-1 resume wedge (illegal queued→committed on resume): publisher now walks the legal
  state path from the row's CURRENT state; fake test store now enforces the machine (5ecc639).
- C-2 post-broadcast UI mis-marking: PublicationError.broadcast; UI no longer fails rows
  after broadcast (5ecc639, b543d5d); publishImage desync guard skips chunk re-upload when
  a message journal already exists (b543d5d).
- I-3 transient rebroadcast errors no longer abandon (5ecc639). I-4 group-reclaim
  abandon+requeue (d8807ec). I-5/I-6/M-1 reclaim accounting: chunk capacity reserved at
  commit, CAS commit, net-of-fee release (d8807ec). M-2 worker commit heals reserve (6e4b007).
- Agent-1 I-1: native two-pass sampled decode (OOM on huge photos), bitmap recycle on
  error, picker 64 MB cap + invalidate() (28b21fc).
- Agent-3 I-2 (sender-reclaim griefing): incoming attachment keys now persisted in the
  encrypted DB at discovery (schema v8), chain re-derivation is the legacy fallback;
  spec §3 step 3 amended (478ac87).
- Affordance/UX: expired no longer offers retry, outgoing bubbles no longer offer
  tap-to-load, loadFull double-tap guard, render-time decode guarded, stranded
  insertImageDraft marks failed (83ab115).
- Minors (e4d73df): thumbnail content sniff + encryption_algorithm fail-closed in
  checkManifest, trackBroadcastSpend on the last two resume branches, strict worker hex,
  payloadBytes wipe, capacity comment corrected.

DEFERRED (recorded, not blockers): Kotlin per-byte hex perf (M-2); abandoned-tx inputs
stay cache-marked until restart (M-3, bounded); crash-stranded pre-pending rows have no
healer (pre-existing design gap — publishText is UI-driven; needs a product decision);
dev-mode LogBox surfaces console.error full-screen (F-4); E9 manual/TTL reclaim (product
decision, disclosed in threat model); multi-manifest messages persist only the last image
(protocol allows 4, UI/schema are single-image — cap the sender at 1 or design N later).

Final gate: vitest 628+1, eslint, prettier --check, cargo 7/7, compileDebugKotlin +
assembleDebug all green.

## Phase 12 kick-off (2026-07-26, Linux-verifiable iOS prep)

ios-prep.md refreshed to current truth (0020367: schema v8, shipped Android image codec
contract folded into iOS requirements — sampled decode, handle lifecycle, EXIF strip;
locked-probe honesty for iOS Keychain WhenUnlocked; app-extraction map recorded for the
apps/ios session). Shared conformance runner (5771aab): typed suite registry +
platform-neutral loaders in cemp-test-vectors — one entry point for the future iOS
runner, version-locked, registry completeness asserted (633 vitest). KDF C core vendored

- validated (d61a13e): phc-winner-argon2 @20190702 (CC0) + Tarsnap scrypt @1.3.3 (BSD),
  4/4 known-answer vectors byte-identical incl. full-strength argon2id m=64MiB/t=3/p=1 and
  scrypt logN=17/r=8/p=1 — the exact core the Swift CempKdf module will wrap; wrapper
  subtleties documented (argon2 v0x13, KiB units, ref/no-threads build, dkLen=32).
  Deferred to macOS host (recorded in ios-prep.md): apps/ios target, Swift wrappers
  (CempKdf, CoreImageCodec, PHPicker, BGTaskScheduler), extraction execution, iPhone
  pairing.

## Phase 12 remote macOS session part 1 (2026-07-26): iOS target + CempKdf GREEN

iOS target ENABLED in the existing RN app (no separate apps/ios needed):
apps/android/ios/ stock 0.83.10 tree (bundle id com.cempmobile, CellSend),
.github/workflows/ios-build.yml = remote macos-26 validate loop (unsigned;
no signing secrets required — gh secret list is empty; copy HTMLocal
ASC_*/cert/profile secrets when device deployment starts). Remote iteration
(agent-11, 8 CI runs): skeleton build green (run 30188006154), then CempKdf
module green incl. XCTest (run 30190483652): legacy RCTBridgeModule over the
RN 0.83 interop layer, EXACT Android bridge contract (native-kdf.ts
unchanged), vendored tools/kdf-c-core C sources, all 4 KDF vectors
byte-identical on an iPhone simulator. Fixes landed en route:
cli-platform-ios devDep, pod-install CWD + pipefail + CocoaPods null-byte
retry, xcodeproj-gem target script (scripts/add-kdf-targets.rb), and a
LATENT repo-wide bug — the brace-expansion@5.0.8 audit override broke
minimatch@3 consumers (glob@7 / RN codegen, ALL platforms); fixed via
patches/minimatch@3.1.5.patch accepting both export shapes (audit gate
intact). op-sqlite SQLCipher flag confirmed honored in the iOS pod build.
Remaining ios-prep items: BGTaskScheduler bridge, Core Image codec, device
deployment (needs signing secrets + first-device smoke list in ios-prep.md).
Android re-verified after the dep changes (compileDebugKotlin OK; 633
vitest).

CI audit gate replaced (2026-07-26): the npm registry started returning
gzip-encoded advisory responses that pnpm 10.32.1's audit fetch cannot decode
(100% reproducible locally + CI). New gate `tools/audit-deps/audit.mjs`: prod
closure via `pnpm ls --prod --recursive` (identical scope), bulk advisory
endpoint with accept-encoding: identity (sidesteps the bug), same high+ bar.
556 prod packages scanned, gate PASSED locally.

## Phase 12 remote part 2 (2026-07-26): iOS Core Image codec GREEN

CempImageCodec native module (feat/ios-image-codec, merged 7baaabc; CI run
30193124060, one run to green): legacy RCTBridgeModule mirroring the Android
bridge contract exactly (no JS changes); ImageIO two-pass sampled decode
(longest edge ≤ 2560, OOM-proof), EXIF orientation baked natively,
CGImageDestination-only output (strip by construction), NSLock handle
registry with fresh-buffer alias-safe resize, JPEG encode with quality
control. 7 codec XCTests + 4 KDF vectors pass on an iPhone simulator. WEBP
VERDICT: ImageIO (iOS 26.5 simulator) does NOT encode webp (decode works) —
encode("webp") throws the pinned CempImageCodecErrorWebPUnsupported; iOS
sends default to JPEG (protocol-legal; ios-prep amended). Auto-accepted
either-way test contract covers devices whose ImageIO does encode webp.
Remaining ios-prep: PHPicker bridge, BGTaskScheduler bridge, keystore/
storage iOS adapters, iOS app-container wiring, device deployment (needs
signing secrets).

Follow-up (2026-07-26): pinned Ruby 3.3 in ios-build.yml (dca25b2) after the
CocoaPods null-byte flake (CocoaPods/CocoaPods#12798) burned all 3 retries on
main; ios-build on main green since (run 30194390437).

## Phase 12 remote part 3 (2026-07-26): iOS PHPicker bridge GREEN

CempImagePicker native module (feat/ios-image-picker, merged 47d18eb; CI run
30199108844, 13/13 tests): PHPickerViewController bridge mirroring the
Android pick() → hex|null contract exactly (native-image-picker.ts +
pick-result.ts unchanged). Two-layer structure per precedent: React-free
CempImagePickerEngine (single in-flight pending-promise with supersede
rejection, late-result drop, invalidate() rejects pending — the Android
fixes ported), thin PHPicker shell. 64 MB byte cap; results loaded as raw
public.data — NO transcoding/re-encode (the codec pipeline owns that);
result bound to the completion captured at arrival (race fix). PHPicker
presentation on a real device is a first-device checklist item. Image-side
native modules are now COMPLETE on iOS (kdf, codec, picker). Remaining:
BGTaskScheduler bridge, keystore/storage adapters + app-container wiring,
device deployment.
