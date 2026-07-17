# CEMP Mobile

Android-first, post-quantum direct messaging where **Nervos CKB cells are the transport layer**.

Encrypted payloads are published to CKB as sender-owned cells, discovered and decrypted by the
recipient, and reclaimed by the sender after acknowledgement. There is no central messaging
server: the blockchain is the temporary availability layer, and the phone is the permanent
message store.

> **Status: early development — CKB testnet only.**
> Cryptography (ML-DSA-65 / ML-KEM-768) and the message/reclaim protocol are not yet audited.
> Do not use with real funds. The operational wallet is for messaging floats only; see the
> [wallet warning](docs/architecture/overview.md#operational-wallet-warning).

## Documentation

| Document                                   | Purpose                                                             |
| ------------------------------------------ | ------------------------------------------------------------------- |
| [`ckd.txt`](ckd.txt)                       | Full product and engineering specification (source of truth)        |
| [`docs/grounding/`](docs/grounding/)       | Verified facts from the reference projects and CKB knowledge graphs |
| [`docs/protocol/`](docs/protocol/)         | Wire-level protocol specification (Phase 1)                         |
| [`docs/architecture/`](docs/architecture/) | System design, service boundaries, network config                   |
| [`docs/threat-model/`](docs/threat-model/) | Trust boundaries and privacy limitations                            |
| [`docs/adr/`](docs/adr/)                   | Architecture decision records                                       |
| [`AGENTS.md`](AGENTS.md)                   | Permanent operating rules for coding agents                         |

## Repository layout

```text
apps/
  android/                React Native Android app (scaffolded during app implementation)
packages/
  cemp-core/              Protocol schemas, envelope/payload types, IDs, state machines
  cemp-ckb/               CKB RPC/indexer/CKBFS provider interfaces, transaction builders
  cemp-crypto/            CryptoProvider: ML-KEM-768, ML-DSA-65, AES-256-GCM, HKDF domains
  cemp-database/          Encrypted SQLite schema, migrations, repositories
  cemp-secure-vault/      Key vault interface (Android Keystore now, iOS Keychain later)
  cemp-ui/                Shared UI components/screens
  cemp-test-vectors/      Golden serialization and crypto test vectors
contracts/
  cemp-message-type/      On-chain CEMP message type script (Rust, later phase)
  deployment/             Deployment records for contract/type-script releases
tools/
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
