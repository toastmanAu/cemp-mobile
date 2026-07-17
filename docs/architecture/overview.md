# Architecture overview

Derived from the spec (ckd.txt §4). Interface-driven layers; platform-specific
code lives behind interfaces so a future iOS client can share the protocol,
cryptography, transaction-building, database schema, and most UI logic.

```text
UI
 ├── Conversations
 ├── Contacts
 ├── Wallet
 ├── Settings
 └── Diagnostics
       │
Application services
 ├── MessageService
 ├── ContactService
 ├── WalletService
 ├── SyncService
 ├── ReclaimService
 └── NotificationService
       │
Shared protocol  (packages/cemp-core, cemp-ckb, cemp-crypto)
 ├── CEMP codec
 ├── Crypto provider
 ├── Transaction builders
 ├── Cell query provider
 ├── Receipt state machine
 └── CKBFS adapter
       │
Infrastructure
 ├── CKB RPC
 ├── CKB indexer
 ├── Local encrypted database  (packages/cemp-database)
 ├── Android background worker (WorkManager)
 └── Android secure vault      (packages/cemp-secure-vault)
```

## Service boundaries

- `packages/cemp-core` — platform-neutral protocol: envelope/payload types,
  conversation/route-tag derivation, states, limits, network configuration.
  No React Native imports.
- `packages/cemp-ckb` — `CkbRpcProvider` / `CkbIndexerProvider` / `CkbfsProvider`
  interfaces and transaction builders. CCC (`@ckb-ccc/core`) is the reference
  SDK behind these interfaces (see ../grounding/ckb-knowledge-graph-routes.md).
- `packages/cemp-crypto` — `CryptoProvider` boundary (ML-DSA-65, ML-KEM-768,
  AES-256-GCM, HKDF). Production signing migrates into audited Rust/native code
  behind the same interface.
- `packages/cemp-secure-vault` — vault boundary: Android Keystore wrapping,
  encrypted vault file, PIN/biometric unlock, in-vault signing.
- `packages/cemp-database` — encrypted SQLite schema, migrations, repositories.

## Messaging model (revised, spec §6)

Sender-owned message cells with recipient-indexable type args
(`version || route_tag || conversation_tag || message_nonce`). The prototype's
recipient-owned notification cell was dropped because it blocks prompt sender
reclamation. Receipts travel inside response messages; the sender reclaims
cells after acknowledgement or expiry; the recipient monitors the outpoint
until spent and keeps local history (AGENTS.md rules 8–9).

## Operational wallet warning

Onboarding and wallet screens must state (spec §2.4):

> This wallet is intended to hold a limited CKB balance for messaging
> operations. It has not been designed, audited, or recommended as a primary
> wallet or long-term store of funds.

The app encourages a configurable maximum operational balance. Balance display
distinguishes: total, available, reserved for pending messages, reclaimable,
and pending-transaction capacity (spec §5.5).

## Background synchronisation (spec §12)

WorkManager workers (profile refresh, message discovery, pending transactions,
watched outpoints, attachments, receipts, reclaim batches, balance refresh, DB
maintenance) plus immediate sync on foreground/conversation/pull-to-refresh/
send/network-available. No real-time delivery promises: latency depends on
block production, inclusion, indexer sync, and Android background execution.

## Network layer (spec §13)

Bundled public testnet endpoints, user-configurable RPC/indexer, ordered
fallbacks with health checks, endpoint pinning, local node support, later
Tor/proxy. Never silently switch networks (AGENTS.md rule 11).
