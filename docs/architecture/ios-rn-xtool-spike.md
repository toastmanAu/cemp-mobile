# iOS Phase 12 — Task 0: React-Native-in-xtool de-risk spike

**Status:** not started · **Blocks:** all of `ios-prep.md` Tasks 1–7 · **Owner:** —

## Why this exists

The iOS-on-Linux distribution pipeline is **proven** (`~/HTMLocal/local-html-browser`:
`xtool dev build` + `xtool dev run --usb` on Ubuntu, GitHub `macos-26` runner for
archive/sign/App-Store upload, physical-iPhone acceptance). But HTMLocal is a
**native Swift/SwiftPM** app. CEMP Mobile is **React Native 0.83**. xtool builds
SwiftPM packages; an RN iOS target pulls in CocoaPods / RN pods, Hermes, and
New-Architecture (bridgeless) codegen — a materially heavier integration.

**The single unknown that gates the whole iOS effort is: does xtool build and run
a React Native 0.83 iOS app at all?** Everything downstream (the 5 native modules,
the shared-package promotion, device acceptance) assumes it does. Prove or
disprove that FIRST, on a throwaway target, before investing in the modules.

## Goal

A minimal RN 0.83 iOS app — no CEMP code — that xtool builds on driveThree and
`dev run --usb` launches on a physical iPhone, rendering a screen and running JS
from the embedded Hermes bundle. Success or a documented, specific blocker.

## Steps

1. **Baseline the Android RN app's iOS half.** `apps/android` is RN 0.83 but has
   no `ios/` tree (cli-generated Android only). Generate a stock RN 0.83 `ios/`
   target (or a fresh `npx @react-native-community/cli init` throwaway pinned to
   0.83.10) to get the reference Podfile / Xcode project / Hermes config.
2. **Attempt the xtool path.** Author an `xtool.yml` for the RN app and run
   `xtool dev build`. Expect friction: xtool wants SwiftPM; RN ships a
   `.xcodeproj` + CocoaPods. Determine whether xtool can consume the RN Xcode
   project, or whether RN's pods must be expressed to xtool another way. This is
   the crux — timebox it.
3. **Hermes + New Arch.** Confirm the Hermes bytecode bundle embeds and loads
   (RN 0.83 is bridgeless-only). The Android side already taught us bridgeless
   surprises (HeadlessJsTask module absent) — watch for the iOS analogue.
4. **Device run.** `xtool dev run --usb` to a physical iPhone; confirm the JS
   screen renders. If device signing is needed, reuse the HTMLocal secrets/profile
   setup.
5. **Fallback probe (only if 2–4 blocks).** Try the macOS-runner path for the RN
   *build* too (not just archive) — i.e. can `ios-release.yml`-style `xcodebuild`
   on `macos-26` build the RN app even if xtool-on-Linux can't? That preserves the
   ship pipeline while conceding local Linux builds.

## Decision gate (record the outcome here)

- **GREEN — xtool builds+runs RN on Linux:** proceed to `ios-prep.md` Tasks 1–7 as
  written; the native modules (CempKdf, SQLCipher flag, BGTaskScheduler, Core
  Image) are the remaining work, all against a shared, already-tested JS/TS core.
- **AMBER — RN builds only on the macOS runner, not xtool-on-Linux:** the ship
  pipeline still works (archive/sign/upload on `macos-26`); local iterate loop is
  slower (no `dev run --usb`). Decide whether that's acceptable or whether a
  native-Swift shell is worth it.
- **RED — RN-in-xtool is a dead end:** escalate. Options: (a) macOS-runner-only RN
  builds, (b) a thinner native-Swift iOS client over the shared protocol/crypto
  (heavier — loses the shared RN UI layer), (c) defer iOS.

## Cost

Small and bounded — a throwaway RN target + xtool attempts. **Days, not weeks**,
and it converts the biggest iOS unknown into a known before any module work.

## References

- Pipeline: `~/HTMLocal/local-html-browser` — `ios/xtool.yml`, `ios/build-release.sh`,
  `.github/workflows/ios-release.yml`, `docs/RELEASE.md`, `docs/IOS_DEVICE_ACCEPTANCE.md`.
- Downstream plan: `docs/architecture/ios-prep.md` (Tasks 1–7).
- Gotcha precedent: HTMLocal vendors ZIPFoundation 0.9.20 so the xtool iOS
  cross-build resolves zlib correctly — expect analogous RN/pod cross-build quirks.
