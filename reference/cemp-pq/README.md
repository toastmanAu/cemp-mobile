# CEMP-PQ

CKB Post-Quantum Encrypted Messaging Protocol.

This project implements a post-quantum messaging protocol on the Nervos CKB blockchain using:
- **ML-DSA-65**: For post-quantum identity signatures and transaction authorization.
- **ML-KEM-768**: For secure key encapsulation.
- **AES-256-GCM (AEAD)**: For production-grade authenticated encryption of message payloads, derived via a shared key.
- **Type ID**: CKB's native Type ID system script to ensure Profile Cells have a stable, globally unique on-chain identifier.

## Compatibility

- **CCC Version**: `@ckb-ccc/core@^1.12.0` (fully compatible with the ChainPay integration suite).

## Protocol Phases

### Phase 0: Profile Creation
Users deploy a **Profile Cell** containing their ML-DSA and ML-KEM public keys and optional metadata, serialized using the Molecule format. The Profile Cell is protected by a stable **Type ID** to allow permanent, deterministic discovery.

### Phase 1: Encrypted Message Publication
To send a message, the sender:
1. Discovers the recipient's ML-KEM public key from their Profile Cell using the Type ID script.
2. Encapsulates a shared symmetric key using ML-KEM.
3. Encrypts the message using **AES-256-GCM** via the Web Crypto API.
4. Publishes a **Message Cell** (owned by the sender) and a **Notification Cell** (owned by the recipient) pointing to the message.

---

## Installation & Testing

### Installation

```bash
npm install
```

### Running Tests

Library round-trip (ML-KEM + AES-GCM, no chain):
```bash
npm run test:lib
```

Transaction builder structure (mock signer, no chain):
```bash
npm run test:builder
```

Both of the above (offline, default `npm test`):
```bash
npm test
```

Live on-chain test against CKB Testnet (requires a funded ML-DSA lock address):
```bash
npm run test:live
```

### Helper Scripts

Print the testnet address derived from `live-test.js`'s seed and show its balance — use this to fund the live-test account:
```bash
node derive-address.js
```

Confirm a tx pair landed on testnet (edit the hashes in the file):
```bash
node verify-txs.js
```

### Verified On-Chain (Testnet)

Round-trip executed 2026-05-29 against `ckb-ccc/core@1.12`:

| Phase | Tx Hash | Status |
|---|---|---|
| 0 — Profile Cell create | `0x765d3d9019335ea221590f61b0ce9c82cd29b7514b6cc638af6584f19a15e7ed` | committed |
| 1 — Encrypted Message + Notification | `0x224eee0549fac21f063bd5d971bb0eb779da8d5c7125e95825cd784f3c579a7d` | committed |

ML-DSA-65 lock cell: `tx_hash=0xba4a6560ef719b24d170bf678611b25b799c56e6a80f18ce9c79e9561085cba7`, `code_hash=0x8984f4230ded4ac1f5efee2b67fef45fcda08bd6344c133a2f378e2f469d310d`.
