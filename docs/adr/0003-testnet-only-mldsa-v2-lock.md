# ADR 0003: Testnet only, targeting the v2 ML-DSA-65 lock deployment

- Status: Accepted (2026-07-17)
- Context: The prototype targeted the legacy v1 ML-DSA lock, whose signing
  digest covers only the transaction hash (documented HIGH-1 gap) and whose
  deploy key is lost (immutable, unfixable). Eight v2 locks are live on testnet;
  the canonical pick is `mldsa65-lock-v2-rust`. The v2 signing path (full
  CighashAll) currently exists only in Rust — there is no JS v2 SDK
  (../grounding/reference-projects.md §3).
- Decision:
  - All development targets CKB testnet (spec §3); testnet and mainnet config
    are structurally separate (AGENTS.md rule 11).
  - `packages/cemp-core` network configuration pins the canonical v2 testnet
    deployment (code hash, deploy out point); business logic reads lock
    deployment from configuration only (spec §3).
  - Phase 4 must deliver a TypeScript CighashAll signer validated against the
    Rust host mirror (`ckb_tx_message_all_host`) with golden vectors, or call
    Rust/WASM — this is the mainnet readiness gate (spec §14.3) and also
    blocks v2 testnet use.
  - Mainnet stays disabled until the deployed lock + signing implementation
    pass the formal readiness checklist (AGENTS.md rule 12), which today has
    exactly one checked item (overflow-checks).
- Consequences: Message/profile transactions built from Phase 5 onward use the
  37-byte v2 lock args and 5,262-byte raw witness format, incompatible with
  the prototype's v1 formats; witness reservation during fee completion is
  ~5.3 KB, affecting fee estimates.
