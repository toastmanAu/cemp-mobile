# iOS preparation (spec Phase 12)

Status of the seven preconditions for creating `apps/ios`. The rule-14 seams
were designed for exactly this: every platform dependency already lives
behind a platform-neutral interface, so each task reduces to "define the iOS
side of an existing seam."

## Task 1 — Remove Android assumptions from shared packages

**Done, mechanically enforced.** No shared package imports `node:*` outside
the declared `./node` subpath modules (Node reference backends for
tests/tooling), and none imports React Native anywhere. Enforced by
`packages/cemp-core/src/platform-boundaries.test.ts` (walks every shared
source file) and by the package-root check (RN bundles only ever pull
`index.ts`, never the node subpaths).

Remaining Android-flavoured content in shared packages is documentation only
(READMEs/doc comments naming the Android implementation — those describe one
implementation of a seam, not a code dependency).

## Task 2 — iOS secure-vault implementation (defined)

The vault needs four platform pieces; the interfaces already exist in
`@cemp/secure-vault` and are implemented for Android in
`apps/android/src/platform/`. The iOS side (to be built in `apps/ios`):

| Seam               | Android impl (reference)                                                        | iOS impl (defined)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PlatformKeyStore` | `android-keystore.ts` (react-native-keychain, biometric slot, THIS_DEVICE_ONLY) | react-native-keychain works on iOS too: same API maps to iOS Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `LAContext` biometric gate). The blob codec (`keychain-blob.ts`) is platform-neutral and reusable unchanged.                                                                                                                                                                                                                                      |
| `VaultStorage`     | `vault-storage.ts` (AsyncStorage, hex)                                          | AsyncStorage also works on iOS; the app-private sandbox gives the same guarantees. Same module shape, separate file under `apps/ios`.                                                                                                                                                                                                                                                                                                                                    |
| `KdfEngine`        | `native-kdf.ts` → `CempKdf` Kotlin module (Bouncy Castle argon2/scrypt)         | **iOS needs a native module too — noble argon2/scrypt is as slow on iOS Hermes as on Android.** Plan: a tiny Swift/ObjC module `CempKdf` wrapping a bundled C implementation of argon2id (reference C library, RFC 9106) and scrypt (RFC 7914), exposed with the same `{ argon2id, scrypt } → hex` surface. Byte-compatibility asserted against the existing RFC vectors in `kdf.test.ts` (the iOS engine must produce identical output — that is the conformance gate). |
| Database adapter   | `sqlcipher-adapter.ts` (op-sqlite + `encryptionKey`)                            | **op-sqlite supports iOS natively** — the same `OpSqlCipherAdapter` class should work unmodified on iOS with the SQLCipher flag enabled in the iOS build. Verify at first iOS build (same plaintext-header check as Android).                                                                                                                                                                                                                                            |

The vault's own logic (multi-slot VEK, file format v1, auto-lock, wipe) is
fully platform-neutral and needs no change.

## Task 3 — iOS background-fetch expectations (defined)

Android's WorkManager gives reliable periodic work; iOS does not offer an
equivalent for this use case. Honest mapping of the §12 workers:

- **BGTaskScheduler** (`BGProcessingTaskRequest`, `BGAppRefreshTaskRequest`)
  is the closest fit: the OS decides when tasks run (typically a few times a
  day on charge, never on a schedule you control). Periodic intervals in
  `WORKER_INTERVALS` are REQUESTS on iOS, best-effort at a fraction of the
  Android cadence.
- **Consequence (design rule): foreground catch-up is the primary sync path
  on iOS** (`SyncEngine.runAllNow()` on every app open + a periodic in-app
  timer while foregrounded). This is already the design — the engine treats
  background slots as accelerators, not the source of truth.
- **Silent push (APNs) is out of scope** — it would introduce a central
  service as a protocol dependency (AGENTS.md rule 10). Documented as a
  deliberate limitation: iOS message latency is app-open latency in the worst
  case.
- **Locked-probe honesty (refined 2026-07-26):** the route-tag cache lives in
  the platform keychain. On iOS, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
  means the locked probe can only run while the DEVICE is unlocked (app
  backgrounded) — with the device locked, NO background work reads the
  keychain, so there is no locked-notification path at all on iOS. This is
  stricter than Android (keystore entries survived lock there) and is the
  honest consequence of no-APNs: device-locked latency = next unlock.
- The `Scheduler` interface in `@cemp/sync` maps cleanly:
  `schedulePeriodic` → `BGAppRefreshTask` (best-effort),
  `scheduleOneShot` → `BGProcessingTask`, `cancel` → `BGTaskScheduler.cancel`.

## Task 4 — Filesystem assumptions replaced by platform adapters

**Done by construction.** The only filesystem contact in shared packages is
behind interfaces: `VaultStorage` (two byte-objects), `SqliteAdapter`
(database), and the Node reference backends (`FileVaultStorage`,
`NodeSqliteAdapter`) live strictly in `./node` subpaths that never ship to a
bundler. iOS equivalents are defined in the Task 2 table. No shared code
reads or writes paths directly.

## Task 5 — Image processing with equivalent iOS behaviour

The image PIPELINE (compress policy, encryption, chunking, manifests) is
platform-neutral in `@cemp/images`; only the `ImageCodec` primitives
(decode/resize/encode) are platform code.

- Android: native codec SHIPPED (2026-07-25) and proven on-device (T17):
  EXIF/GPS stripped by construction, orientation baked into pixels, sampled
  two-pass decode (OOM guard), handle-registry lifecycle with aliasing-safe
  release, picker byte cap (64 MB).
- iOS plan: a `CoreImageCodec` native module (Core Image / vImage):
  `CGImageSource` decode with EXIF orientation applied, Lanczos resize into
  `CIContext`, `CGImageDestination` encode to WebP/JPEG (WebP encode needs a
  bundled encoder — if unavailable, JPEG is the v1 fallback and the format
  field records it, which the protocol already supports).
- **iOS codec contract (from T17 + the delta re-review — these are hard
  requirements, not suggestions):** two-pass sampled decode (bounds pass →
  `inSampleSize`-equivalent, longest edge ≤ 2560 px) so a 50 MP photo can't
  OOM the process; pixel memory released deterministically (the
  `HandleTracker` contract: every handle releasable, aliasing-safe,
  release-on-error); no byte cap missing on the picker read; output bytes
  produced only by the encoder (metadata never carried across — strip by
  construction, verified on Android by on-chain ciphertext scan).
- **Conformance gate:** the shared compress policy is identical — the same
  `compressToLimits` decisions are driven by byte sizes, so both platforms
  produce within-limit, metadata-free outputs. The images test-suite's
  `FakeCodec` contract is the shape each native codec must satisfy.

## Task 6 — Shared protocol conformance tests

The golden vectors ARE the conformance suite, and they are plain JSON
(consumable by any runtime): `packages/cemp-test-vectors/vectors/` covers
serialization (`cemp-v1-serialization.json`), envelope crypto
(`cemp-v1-envelope.json`), ML-DSA v2 signing (`mldsa-v2.json`, also consumed
by the Rust harness today), and the vault format (`cemp-vault-v1.json`).

- Current conformance: TypeScript (vitest) and Rust (signing harness) pass
  byte-identically.
- The suites have a single typed entry point —
  `packages/cemp-test-vectors/src/suites.ts` (registry + loaders, format
  version checked against `VECTOR_FORMAT_VERSION`) — so a future iOS runner
  consumes exactly the same data through one API instead of re-walking
  relative paths.
- iOS requirement at `apps/ios` time: the same vectors run against the iOS
  build (a vitest-equivalent smoke harness or a native test runner reading
  the same JSON). No new vectors needed — any iOS-specific crypto (the KDF
  module) MUST match the existing vectors to be accepted (Task 2). The C
  core that module will wrap is already vendored and vector-validated on
  Linux in `tools/kdf-c-core/` (byte-identical argon2id/scrypt against the
  repo's KDF vectors).

## Task 7 — Database migrations identical

Migrations live in `@cemp/database` (`MIGRATIONS`, `SCHEMA_VERSION = 8`) and
are platform-agnostic SQL + ordered bookkeeping. v7 added
`UNIQUE(message_id)` on attachments; v8 added `attachments.attachment_key`
(incoming attachment keys persisted in the encrypted DB — the iOS build must
open the same schema; the sender-reclaim griefing fix depends on it). Both
platforms open the same adapter interface, so the migration history is
identical by construction. Adding a migration later applies to both builds
simultaneously; there is no platform-specific schema path and there must
never be one (the platform-boundaries test plus review of `migrate.ts` keep
it that way).

---

## What remains before `apps/ios`

1. A macOS build host (Xcode) — the Linux box cannot build iOS binaries.
2. The `CempKdf` native iOS module (Task 2) + vector conformance run. The C
   core is ready and validated (`tools/kdf-c-core/`); what remains is the
   Swift bridge wrapper only.
3. op-sqlite SQLCipher iOS build flag + plaintext-header verification.
4. BGTaskScheduler bridge for the `@cemp/sync` Scheduler seam (Task 3).
5. Core Image codec module (Task 5 — contract updated above) + a JPEG-only
   fallback profile.
6. iPhone pairing for debug (`idevicepair` + `ideviceinfo` are present on
   this machine for the later device checks; deployment itself needs the
   macOS host).

## App-extraction map (verified 2026-07-26; execute at apps/ios time)

Move the platform-NEUTRAL app code out of `apps/android` into a shared
workspace app (e.g. `apps/app-shell`) so `apps/ios` is a thin shell. Do NOT
do this before the consumer exists — the map is the checklist:

- **Move (generic RN / RN-free):** `src/screens/*`, `App.tsx` (tabs/stack),
  `navigation.ts`, `messaging.ts` (composition, RN-free by design),
  `image-send.ts`, `outgoing-tx-journal.ts`, `vault-liveness.ts`,
  `background-sync-core.ts`, and the RN-free platform halves (`hex.ts`,
  `base64.ts`, `keychain-blob.ts`, `pick-result.ts`, `handle-tracker.ts`,
  `scheduler-coalesce.ts`, `best-effort.ts`, `route-tag-cache-core.ts`).
- **Keep per-platform (Android stays / iOS re-implements):** everything in
  `src/platform/` importing `NativeModules` (keystore, notifier, scheduler,
  kdf, image codec, image picker, headless-task, locked-probe,
  route-tag-cache binding), `app-container.ts` (composition root — the
  _shape_ is the template for the iOS container), `background-sync.ts`
  (HeadlessJS entry), `notification-permission.ts` (PermissionsAndroid).
- Carry the polyfills (`react-native-get-random-values`,
  `fast-text-encoding`) and the Metro monorepo config (`metro.config.js`
  watchFolders + symlink exports) to the iOS app. Note the T17 F-3 lesson:
  an actual Metro bundle build is part of the iOS gate, not just tsc.
