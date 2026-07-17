# Grounding: ML-DSA v2 signing pipeline (lock `mldsa65-lock-v2-rust`)

Extracted 2026-07-17 from `~/code/key-vault-wasm/crates/ckb-fips204-utils`
(commit `5cc0c1e`): `src/lib.rs`, `src/signing.rs`, `src/message.rs`,
`src/ckb_tx_message_all_host.rs`; and usage flow from
`~/ckb-mldsa-lock/tests/integration/src/bin/mldsa65_spend_test.rs`.
This is the exact construction the deployed v2 lock verifies on-chain
(proof-of-life spend `0x13404ea7…f8c88`). The TypeScript port in
`packages/cemp-ckb` / `packages/cemp-crypto` is validated byte-for-byte
against `tools/signing-harness`, which vendors the same Rust code.

## Parameter / flag bytes (ML-DSA-65)

- `ParamId::Mldsa65 = 61`; flag = `(param_id << 1) | has_signature`
  → lock args flag `0x7A`, witness flag `0x7B`.
- Lengths (FIPS 204 §4 Table 1): pk 1952 B, sig 3309 B, sk 4032 B.

## Lock args — 37 bytes

```text
[0x80, 0x01, 0x01, 0x01, 0x7A, blake2b_256(pubkey)]
 │     │     │     │      └── flag (param_id<<1)|0
 │     │     │     └───────── pubkey count (single-sig)
 │     │     └─────────────── threshold
 │     └───────────────────── require_first_n
 └─────────────────────────── multisig header marker
pubkey hash: blake2b-256, personalisation "ckb-mldsa-sct"
```

## Key derivation (wallet side)

```text
seed32 (from CEMP HKDF domain "CEMP/CKB/ML-DSA/identity/v1" — spec §5.1)
  → ml_dsa65 keygen_from_seed(seed32)   (FIPS-204 deterministic keygen;
    fips204 crate and @noble/post-quantum must yield identical keypairs —
    cross-checked by golden vector)
```

key-vault-wasm uses `HKDF-SHA256(info = "ckb/quantum-purse/ml-dsa/65/{index}")`
upstream; CEMP substitutes its own domain per spec §5.1.

## CighashAll stream (u32-LE length prefixes — NOT the u64 of classic sighash-all)

```text
stream = tx_hash                                                        // 32 B; raw-tx hash (witnesses excluded from tx hash)
       || for each resolved input, in tx.inputs() order:
              cell_output.as_slice()                                    // molecule-packed CellOutput
              u32_le(cell_data.len()) || cell_data
       || first witness of the script group, SPLIT:
              u32_le(len(input_type_slice))  || input_type_slice        // raw molecule BytesOpt encoding:
              u32_le(len(output_type_slice)) || output_type_slice       //   None → 0 bytes; Some(b) → u32_le(len(b))||b
              // lock field deliberately excluded — it is the signature
       || for each remaining group-input witness (skip 1):
              u32_le(len) || full_witness_bytes
       || for each witness at index >= tx.inputs().len():
              u32_le(len) || full_witness_bytes
```

Host mirror: `ckb_tx_message_all_host::generate_ckb_tx_message_all_host`;
on-chain twin: `ckb_tx_message_all_in_ckb_vm` (must match byte-for-byte —
documented invariant, enforced by round-trip tests in ckb-mldsa-lock).

## Digest and FIPS-204 message framing

```text
digest    = blake2b-256(stream, personalisation "ckb-mldsa-msg")
sig       = ml_dsa65.sign(sk, digest, ctx="CKB-MLDSA-LOCK")            // FIPS-204 pure mode, single wrap
            (the implementation frames M' = 0x00 || 0x0E || "CKB-MLDSA-LOCK" || digest
             internally; Rust harness uses try_sign_with_seed(rnd = 0x00*32) — deterministic;
             noble signs hedged — different bytes, still verifies)
witness lock = [0x7B, pubkey(1952), sig(3309)]                          // 5,262 B
```

The digest is passed RAW with `ctx = DOMAIN`, matching the deployed
`mldsa65-lock-v2-rust` contract, which verifies with
`ml_dsa::VerifyingKey::verify_with_context(digest, DOMAIN, sig)`
(contracts/mldsa-lock-v2-rust/src/entry.rs in ckb-mldsa-lock). The older
fips204-backend sibling lock instead pre-wraps M' and verifies with an empty
ctx (double wrap): `verify(0x00||0x0E||DOMAIN||digest, sig, ctx=[])`. The two
framings produce different internal M' bytes and are NOT cross-compatible.

## Transaction-building flow (from mldsa65_spend_test.rs)

1. Build tx with a placeholder witness: `WitnessArgs{ lock = Some(zero_bytes(1+pk+sig)) }`.
   Placeholder content is irrelevant: witnesses are not covered by `tx.hash()`,
   and the lock field is excluded from the CighashAll stream — but the
   placeholder's _length_ affects fee sizing, so reserve the full 5,262 B.
2. Resolve every input (CellOutput + data) and compute the stream with the
   group-input indices (single-group spends: `[0..input_count)`).
3. digest → sign(digest, ctx=DOMAIN) → set `WitnessArgs.lock = [0x7B, pk, sig]`.
4. Reassemble witnesses and broadcast. Cell dep: deploy tx
   `0x1074b1ac…0cb1` index 3 (`dep_type: code`) for mldsa65-lock-v2-rust.

## Known incompatibility note

fips204-backend and RustCrypto-backend v2 locks are NOT signature-cross-compatible
(different M' framing) though pubkeys/lock_args match — CEMP standardises on the
RustCrypto single-wrap framing above, matching `mldsa65-lock-v2-rust` (the canonical
deployment in `packages/cemp-core` network config).
