# docs/threat-model

Threat model for CEMP Mobile. Phase 11 task 1 requires threat-modelling every
trust boundary; this file starts the record early so design decisions can
reference it.

## Privacy limitations (from spec §15 — must ship in-product)

CEMP provides **payload confidentiality**, not metadata privacy. Observers may
infer: message-like cell creation, cell size, transaction timing, funding
source, reclaim timing, repeated route-tag activity, probable relationships
between participants, attachment size ranges. The product must never claim
Monero-like metadata privacy. Route tags are _pseudonymous routing_ (spec §6.1).

## Trust boundaries to model (Phase 11)

1. RPC / indexer responses → app (treat as hostile input, AGENTS.md rule 4).
2. On-chain cell data → parser/decoder (fuzz all parsers; malformed-input
   behaviour is a Phase 1 deliverable).
3. Contact bundles (QR/pasted) → contact store (trust states, spec §10.3).
4. Vault boundary: mnemonic/seed/keys vs ordinary JS (rules 2–3; spec Phase 3).
5. Android Keystore / lockscreen vs vault unwrapping.
6. Image pipeline: sandboxed decode, decompression bombs, oversized declarations.
7. Reclaim protocol: sender authority vs recipient monitoring (spec §7).
8. Deployed lock trust root: the v2 ML-DSA locks are TYPE-ID-upgradeable by a
   secp256k1 key (a quantum-breakable trust root over PQ verifiers) until the
   mainnet immutable deployment — see ../grounding/reference-projects.md §3.

## Security events

The `security_events` table (spec §11) records key changes, verification
failures and wipe/lock events; unexpected contact key changes must interrupt
sending until acknowledged (spec §10.3).
