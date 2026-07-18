# CEMP Mobile — "CellSend"

![CellSend logo](docs/brand/logo.png)

**CellSend** is the app: Android-first, post-quantum direct messaging where **Nervos CKB cells are the transport layer**.

Encrypted payloads are published to CKB as sender-owned cells, discovered and decrypted by the
recipient, and reclaimed by the sender after acknowledgement. There is no central messaging
server: the blockchain is the temporary availability layer, and the phone is the permanent
message store.

> **Status: early development — CKB testnet only.**
> Cryptography (ML-DSA-65 / ML-KEM-768) and the message/reclaim protocol are not yet audited.
> Do not use with real funds. The operational wallet is for messaging floats only; see the
> [wallet warning](docs/architecture/overview.md#operational-wallet-warning).

## Where things stand (2026-07-17)

- **Full message lifecycle proven live on CKB testnet** by the headless two-user
  [reference client](apps/reference-client/): type-script deploy → Profile Cells →
  encrypted send → discovery + decrypt → ack response → sender reclaim → balance reconcile.
  Every step is a committed, journaled testnet transaction (see its README for tx hashes).
- **Deployed contracts (testnet):** `cemp-message-type` (code hash
  `0xd172d3bf…52234b8`, [`contracts/deployment/`](contracts/deployment/)) and the canonical
  ML-DSA-65 v2 lock — both pinned in `packages/cemp-core/src/network.ts`.
- **Implemented and unit-tested:** the v1 Molecule wire protocol
  ([`docs/protocol/CEMP-PROTOCOL-V1.md`](docs/protocol/CEMP-PROTOCOL-V1.md) + golden
  vectors), the BIP39 → HKDF → ML-DSA/ML-KEM identity chain, the secure vault
  (multi-slot VEK: password Argon2id + biometric keystore slot, auto-lock, wipe),
  the local database (migrations, §11 state machine, repositories), messenger-shell
  view-models, profile key rotation + fingerprints + contact QR bundles + trust verdicts,
  and the Android app skeleton (vault gate → Chats/Contacts/Wallet/Settings).
- **360 unit tests + 1 skipped green** (`pnpm test`), plus ~10k-case malformed-input
  property suites and Rust↔TypeScript interop vectors.

Not yet done: text publication wiring in the app (Phase 7), background workers (Phase 9),
the wallet-balance feed (Phase 4 remainder), first on-device build of the Android app, and
mainnet readiness (Phase 11 gate).

## Documentation

| Document                                                         | Purpose                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`ckd.txt`](ckd.txt)                                             | Full product and engineering specification (source of truth)        |
| [`docs/grounding/`](docs/grounding/)                             | Verified facts from the reference projects and CKB knowledge graphs |
| [`docs/protocol/`](docs/protocol/)                               | Wire-level protocol specification (Phase 1)                         |
| [`docs/architecture/`](docs/architecture/)                       | System design, service boundaries, network config                   |
| [`docs/architecture/ios-prep.md`](docs/architecture/ios-prep.md) | Phase 12 iOS preparation: seam map, background-fetch, conformance   |
| [`docs/threat-model/`](docs/threat-model/)                       | Trust boundaries and privacy limitations                            |
| [`docs/adr/`](docs/adr/)                                         | Architecture decision records                                       |
| [`AGENTS.md`](AGENTS.md)                                         | Permanent operating rules for coding agents                         |

## Repository layout

```text
apps/
  android/                React Native Android app (RN 0.83.10, bootstrapped, testnet-only)
  reference-client/       Headless two-user testnet client (spec §20 lifecycle proof)
packages/
  cemp-core/              Protocol schemas + Molecule codecs, IDs, fingerprints,
                          contact bundles, profile trust, network config
  cemp-ckb/               CKB client (shape-validated), tx builders (profile/message/
                          reclaim/rotate/deploy), ML-DSA v2 signer, discovery, wallet
  cemp-crypto/            BIP39, HKDF identity chain (+rotation), ML-KEM-768, ML-DSA-65,
                          AES-256-GCM envelopes
  cemp-database/          Adapter interface, migrations (schema v2), repositories,
                          §11 message state machine; node:sqlite adapter for tests
  cemp-secure-vault/      Secure vault: multi-slot VEK (password Argon2id + biometric),
                          auto-lock, reveal/quiz, wipe; keystore + storage interfaces
  cemp-ui/                Platform-neutral messenger-shell view-models
  cemp-test-vectors/      Golden serialization, crypto and vault test vectors
contracts/
  cemp-message-type/      On-chain CEMP message type script (Rust, raw-syscall, 3 KiB)
  deployment/             Deployment records (testnet deploy tx + code hash)
tools/
  signing-harness/        Rust ML-DSA v2 golden-vector harness (interop with cemp-crypto)
  devnet/                 Local dev chain helpers
  faucet-helper/          Testnet faucet utilities
  protocol-inspector/     Decode/inspect CEMP cells and envelopes
reference/
  cemp-pq/                Vendored prototype — reference only, NOT production code
docs/
```

## Quickstart

```bash
nvm use            # Node 22
corepack enable    # pnpm via packageManager field
pnpm install
pnpm build         # compile all packages (TypeScript strict)
pnpm test          # unit tests (vitest)
pnpm lint          # eslint
pnpm typecheck     # no-emit type check across packages
```

Run the live testnet lifecycle (read-only unless wallets are funded; it re-verifies and
reconciles on-chain state):

```bash
cd apps/reference-client && pnpm client run
```

Android app (needs an Android SDK machine; headless checks are `typecheck` + repo tests):

```bash
pnpm --filter @cemp/android-app start     # Metro
pnpm --filter @cemp/android-app android   # build + install debug variant
```

Contracts (Rust): `cargo test` in `contracts/`; the type-script binary builds via
`contracts/cemp-message-type/build.sh` (prints its CKB code hash).

## Core principles (from the spec)

- **Messenger first.** Blockchain states are translated into familiar message states
  (Preparing / Sending / Pending / Sent / Received / Cleared / Failed).
- **Local-first storage.** Permanent user data lives only on the device, encrypted.
- **Sender-funded transport.** The sender funds message cells and retains reclaim authority.
- **Post-quantum by default.** ML-DSA-65 transaction authorization, ML-KEM-768 message
  encryption, AES-256-GCM payloads, HKDF domain separation everywhere.
- **No metadata-privacy claims.** Payload confidentiality yes; Monero-like privacy no.

## License

MIT — see [LICENSE](LICENSE). Reference code under `reference/` retains its original
provenance and is not covered by this project's license grant.
