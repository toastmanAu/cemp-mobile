# ADR 0001: pnpm monorepo, TypeScript strict, Rust workspace for contracts

- Status: Accepted (2026-07-17)
- Context: The spec (Phase 0) requires a monorepo with shared platform-neutral
  TypeScript packages, an Android app (later), on-chain contracts in Rust, and
  pinned dependencies with strict TypeScript, ESLint, formatting, and unit tests.
- Decision:
  - pnpm workspaces (`apps/*`, `packages/*`, `tools/*`); `packageManager` pinned
    via corepack; Node 22 (`.nvmrc`).
  - TypeScript 5.9 strict (`tsconfig.base.json`: `strict`,
    `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
  - ESLint flat config + typescript-eslint; Prettier; Vitest run from the root.
  - `contracts/` is a separate Cargo workspace (resolver 2); contracts are not
    part of the pnpm workspace.
  - Packages are kept independently compilable during Phase 0 (no cross-package
    source imports yet); shared protocol types are unified deliberately in
    Phase 1 when the byte-level spec exists, at which point project references
    or path mapping will be introduced.
  - Dependencies pinned exactly (`--save-exact`); `pnpm-lock.yaml` committed.
- Consequences:
  - `pnpm build/test/lint/typecheck` work from a clean checkout.
  - Known risk: Metro (React Native) + pnpm symlinks. Mitigation deferred to
    the app bootstrap: `node-linker=hoisted` for `apps/android` or a separate
    lockfile — recorded in `apps/android/README.md`.
