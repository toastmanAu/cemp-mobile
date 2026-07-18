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
  (our packages export via `"exports"` subpaths). Verified on-device
  (2026-07-18): the following must be DIRECT deps of this package because
  pnpm does not hoist them and the RN build/bundler resolves from
  `node_modules`: `@react-native/gradle-plugin`, `@react-native/codegen`,
  `@react-native-community/cli`, `@babel/runtime`. The RN preset also needs
  `@babel/plugin-transform-export-namespace-from` (workspace dist is ES2020).
- **Hermes polyfills** (loaded first in `index.js`): `react-native-get-random-values`
  (backs cemp-crypto's only CSPRNG) and `fast-text-encoding`.
- **Vault KDF is NATIVE**: pure-JS argon2/scrypt (noble) is unusably slow
  under Hermes — measured on this A53: > 4 minutes for argon2id m=19 MiB/t=2.
  The vault derives through the app-local `CempKdf` Kotlin module
  (Bouncy Castle) via the `KdfEngine` seam in `@cemp/secure-vault`: the same
  argon2id profile completes in **~510 ms**. Vault creation uses the
  OWASP-minimum profile (`src/platform/kdf.ts`, recorded in the vault file
  per rule 13); the desktop default stays at RFC 9106 first profile.
- **SQLCipher**: ENABLED via `"op-sqlite": {"sqlcipher": true}` in
  package.json — required: the DEFAULT op-sqlite build silently ignores
  `encryptionKey` (verified on-device 2026-07-18: plaintext `SQLite format 3`
  header). With the flag, `cemp.db` opens only under the vault-derived key —
  no plaintext header (Phase 3/6 exit criteria verified on-device). NOTE:
  enabling it invalidates any DB created by the plaintext build — delete
  `databases/cemp.db` once when upgrading.
- **Dependency floor**: the user's pnpm `minimumReleaseAge` (5 days) pins us
  back from day-old releases — react-native is 0.83.10 rather than 0.86 for
  that reason; `react-native-screens` is 4.25.0 (peer range wants RN ≥ 0.82).
- **First device checklist** (Galaxy A53, 2026-07-18): ~~app launches past
  the vault gate~~ ✓; ~~create wallet → reveal shows 12 words~~ ✓ (native
  argon2id 510 ms); ~~lock → unlock with password~~ ✓ (392 ms); ~~auto-lock
  after 5 min~~ ✓; ~~add contact → persists across restarts~~ ✓; ~~contact →
  conversation → send local message (`queued`/`sending…` bubble)~~ ✓;
  ~~kill app → restart → state intact~~ ✓; ~~DB encrypted at rest
  (SQLCipher)~~ ✓. Biometrics NOT yet tested (needs an enrolled finger on
  the prompt). ADB-driving note: the soft IME covers the composer SEND
  button — focus the field, then TAB + ENTER to click.
