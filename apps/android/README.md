# @cemp/android-app

CEMP Mobile — Android application (React Native 0.83.10, Hermes, TypeScript
strict). **Testnet-only build** (AGENTS.md rule 11): all chain access goes
through `CKB_TESTNET` from `@cemp/core`; the wallet screen carries the
spec-mandated experimental-operational-wallet warning.

## What is where

- `src/App.tsx` — vault gate → bottom tabs (Chats / Contacts / Wallet /
  Settings, spec §16.1) + stack (Chat, ContactEdit).
- `src/app-container.ts` — composition root: platform seams → vault →
  SQLCipher database (key from the vault) → repositories. A 1 s poll observes
  the vault's auto-lock timer and tears the DB down when it fires.
- `src/screens/` — thin screens bound to the `@cemp/ui` view-models.
- `src/platform/` — the rule-14 platform implementations:
  - `android-keystore.ts` — `PlatformKeyStore` over `react-native-keychain`
    (biometric-gated wrap for the vault's biometric slot + `cemp.dbkey`;
    `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, secrets never migrate off-device).
  - `vault-storage.ts` — `VaultStorage` over AsyncStorage (hex-encoded).
  - `sqlcipher-adapter.ts` — `SqliteAdapter` over `@op-engineering/op-sqlite`
    with the vault-derived SQLCipher key.
- `android/` — the RN 0.83.10 native template (generated with
  `@react-native-community/cli init --version 0.83.0`, then adapted).
- `index.js`, `metro.config.js`, `babel.config.js` — entry + bundler config.

## Build variants (Phase 0 task 6)

- **debug** — `applicationIdSuffix ".debug"`, installs side-by-side with
  release: `pnpm android` (or `react-native run-android`).
- **release** — `pnpm android:release`. BOOTSTRAP ONLY: release is signed
  with the checked-in debug keystore so variants are testable; replace with a
  proper upload key before any distribution.

## Building on a machine with the Android SDK

Prereqs: JDK 17+, Android SDK (platform + build-tools matching
`android/build.gradle`), `ANDROID_HOME` set, an emulator or device.

```bash
pnpm install                 # from the repo root
pnpm --filter @cemp/android-app start     # Metro, in one shell
pnpm --filter @cemp/android-app android   # builds + installs the debug variant
```

Headless checks that run WITHOUT the SDK (CI-safe):

```bash
pnpm --filter @cemp/android-app typecheck
pnpm test                                  # repo-wide vitest (includes src/platform tests)
```

## Known integration notes

- **pnpm + Metro**: `metro.config.js` watches the workspace root and resolves
  against both `node_modules` roots with symlink + package-exports support
  (our packages export via `"exports"` subpaths). If resolution still bites,
  the documented fallback is `node-linker=hoisted` in a package-local
  `.npmrc` (ADR 0001).
- **SQLCipher**: op-sqlite must be built in its SQLCipher configuration for
  the `encryptionKey` open option to take effect — follow the op-sqlite
  README (SQLCipher build flag) and VERIFY at first device build that the
  database file is not readable without the key (Phase 3 exit criterion).
  Until that check is done, treat on-device data as unverified-encrypted.
- **Dependency floor**: the user's pnpm `minimumReleaseAge` (5 days) pins us
  back from day-old releases — react-native is 0.83.10 rather than 0.86 for
  that reason; `react-native-screens` is 4.25.0 (peer range wants RN ≥ 0.82).
- **First device build checklist**: app launches past the vault gate; create
  wallet → reveal shows 12 words; lock → unlock with password; enable
  biometrics → lock → biometric prompt appears; add contact → send local
  message (stays `queued` until Phase 7 wires publication); kill app →
  restart → state intact.
