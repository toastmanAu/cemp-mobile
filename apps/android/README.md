# @cemp/android-app

The React Native Android application lives here.

Status: **not yet scaffolded.** The React Native bootstrap (with debug/release
build variants, per ckd.txt Phase 0 task 6) is an implementation task tracked on
the project kanban board — it is deliberately deferred until the headless
two-user testnet reference client proves the full message lifecycle
(ckd.txt §20), so app work does not entangle with the reclaim state machine.

Requirements at bootstrap time:

- React Native + TypeScript, strict mode
- React Navigation; bottom navigation: Chats / Contacts / Wallet / Settings (§16.1)
- Encrypted SQLite via SQLCipher; key wrapped by Android Keystore (§4.1)
- WorkManager background workers (§12)
- Testnet-only network configuration (AGENTS.md rule 11)
- Debug and release build variants

Known tooling note: pnpm's symlinked store can confuse Metro. If that bites,
options are `node-linker=hoisted` in `.npmrc` for this package or a dedicated
lockfile for the app — decide when the app is scaffolded (see ADR 0001).
