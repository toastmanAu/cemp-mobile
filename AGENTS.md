# AGENTS.md — CEMP Mobile

Guidance for coding agents working in this repository. The product and engineering
specification is [`ckd.txt`](../ckd.txt) — it is the source of truth. Grounding notes
verified against the reference codebases and CKB knowledge graphs live in
[`docs/grounding/`](docs/grounding/).

## Permanent operating rules (from the specification)

1. Do not change protocol serialization without updating the protocol
   specification, golden vectors and migration version.
2. Never log mnemonics, seeds, secret keys, decrypted payloads, vault
   passwords, database keys or plaintext attachments.
3. Never store permanent plaintext messages or images outside the encrypted
   application database and encrypted attachment directory.
4. Treat RPC and indexer responses as hostile input.
5. Every background operation must be idempotent.
6. Every transaction must be journaled locally before broadcast.
7. Never infer successful delivery from transaction commitment alone.
8. Never delete local user history merely because its transport cell was
   reclaimed.
9. The sender must retain reclaim authority over message and attachment cells.
10. Do not introduce a central service as a protocol dependency.
11. Testnet and mainnet configuration must be structurally separate.
12. Do not enable mainnet until the configured ML-DSA lock deployment and
    transaction signing implementation have passed the formal readiness gate.
13. All cryptographic algorithms and serialized objects must be versioned.
14. New native functionality must be exposed through a platform-neutral
    interface so an iOS implementation can be added later.
15. Keep blockchain terminology out of the ordinary chat workflow unless an
    error requires it.

## Additional repository rules

- `reference/` is vendored prototype code for reading only. Never import it from
  `packages/`, `apps/`, `contracts/` or `tools/`, and never edit it as if it were
  production code.
- Shared packages must not import React Native or other platform UI modules.
  Platform-specific code lives behind interfaces in `cemp-secure-vault` and
  `apps/android`.
- `packages/cemp-core` is dependency-light and platform-neutral: it must stay
  runnable in Node, React Native (Hermes), and future iOS contexts.
- Network identifiers, deployed contract hashes, and endpoints live in
  `packages/cemp-core` network configuration — never hard-coded in feature code.

## Commands

```bash
pnpm install          # install workspace dependencies
pnpm build            # compile all TypeScript packages (strict mode)
pnpm test             # run unit tests (vitest, from repo root)
pnpm typecheck        # no-emit type check across packages
pnpm lint             # eslint (flat config, typescript-eslint)
pnpm format           # prettier
cargo test            # contracts/ workspace (Rust), when contracts exist
```

## Conventions

- TypeScript strict mode everywhere; `tsconfig.base.json` is the shared base.
- Dependencies are pinned exactly (`--save-exact`); `pnpm-lock.yaml` is committed.
- Unit tests live next to sources as `*.test.ts`; golden/cross-runtime vectors
  live in `packages/cemp-test-vectors`.
- Schema changes require a migration with an explicit schema version in
  `cemp-database` (see spec §11).
- Commit messages: conventional commits (`feat(scope): …`, `fix(scope): …`).
