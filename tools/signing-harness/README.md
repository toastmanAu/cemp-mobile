# signing-harness

Standalone Rust dev tool for the **v2 ML-DSA-65 CKB signing pipeline**
(`mldsa65-lock-v2-rust`). It does two things:

1. **`vectors`** — generates the golden test vectors consumed by the
   TypeScript port of the same pipeline (`packages/cemp-ckb` /
   `packages/cemp-crypto`), written to
   `packages/cemp-test-vectors/vectors/mldsa-v2.json`.
2. **`verify`** — verifies externally produced ML-DSA-65 signatures (e.g. from
   the TypeScript port) against a CighashAll stream.

It is a standalone cargo crate: the empty `[workspace]` table in `Cargo.toml`
keeps it independent of the `contracts/` cargo workspace. Nothing else in the
repo depends on it.

## Provenance

The algorithm code is **vendored** from
`~/code/key-vault-wasm/crates/ckb-fips204-utils` (commit `5cc0c1e`), ML-DSA
subset, as a dev-tool copy — see the provenance header in each vendored file:

- `src/lib.rs` — `ParamId` (ML-DSA variants only), `construct_flag` /
  `destruct_flag`, `Hasher` (`script_args_hasher`, `message_hasher`),
  `DOMAIN`, `lengths`, `lock_args`, `LOCK_ARGS_LEN`, `Error` subset.
  Falcon variants/hashers, the HKDF KDF helpers and the no_std/ckb-vm cfgs
  were dropped; semantics unchanged.
- `src/message.rs` — FIPS-204 M' construction, verbatim (std-only).
- `src/ckb_tx_message_all_host.rs` — host CighashAll streamer, verbatim.

The `fips204` call patterns in `src/main.rs` mirror the upstream `signing.rs`
and `verifying.rs`: `ml_dsa_65::KG::keygen_from_seed(&seed)`,
`PrivateKey::try_from_bytes`, `try_sign_with_seed(&[0u8; 32], &final_msg, &[])`,
and `PublicKey::try_from_bytes` + `pk.verify(&final_msg, &sig, &[])`.

The full pipeline is documented in
[`docs/grounding/mldsa-v2-signing-pipeline.md`](../../docs/grounding/mldsa-v2-signing-pipeline.md).

## Dependency versions

Pinned to the exact resolutions in `~/code/key-vault-wasm/Cargo.lock`
(commit `5cc0c1e`) — the same dependency set the production signer/verifier
runs on. Resolved in this crate's own `Cargo.lock`:

| crate                          | version                   | note                                                                                                                                          |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `fips204`                      | 0.4.6                     | `default-features = false`, features `ml-dsa-44/65/87`                                                                                        |
| `ckb-types`                    | 0.200.0                   | transaction/molecule building                                                                                                                 |
| `ckb-hash`                     | 0.200.0                   | provides `Blake2bBuilder`; `ckb-contract` feature → pure-Rust `blake2b-ref` 0.3.1 backend, byte-identical to the default `blake2b-rs` backend |
| `serde` / `serde_json` / `hex` | 1.0.219 / 1.0.142 / 0.4.3 | JSON + hex plumbing only                                                                                                                      |

`hkdf` / `sha2` from the upstream signer are **not** needed here: upstream
derives the ML-DSA child seed via HKDF from a master seed, while this harness
takes the 32-byte child seed directly (the vectors fix the seeds).

## Usage

From the repo root:

```bash
# regenerate the golden vectors
cargo run --manifest-path tools/signing-harness/Cargo.toml -- \
  vectors --out packages/cemp-test-vectors/vectors/mldsa-v2.json

# verify an externally produced signature (hex, 0x prefix optional)
cargo run --manifest-path tools/signing-harness/Cargo.toml -- \
  verify --pubkey <hex> --signature <hex> --stream <hex>
# prints OK (exit 0) or FAIL (exit 1); usage/parse errors exit 2
```

`verify` recomputes `digest = blake2b-256(stream, personal "ckb-mldsa-msg")`
and `final_msg = 0x00 || 0x0E || "CKB-MLDSA-LOCK" || digest` from the stream,
then runs the FIPS-204 ML-DSA-65 verify with empty ctx.

## Determinism note

The `sign` vector is **byte-deterministic across runs** because the harness
signs with `try_sign_with_seed(rnd = 0x00*32)` — FIPS-204 "deterministic"
mode. Production signing (`signing.rs` upstream, and the noble-based
TypeScript port) is **hedged** (randomized rnd), so production signatures over
the same `final_msg` differ byte-for-byte from the vector but still verify.
Regenerating the vector file twice must produce identical output; this is
checked by diffing two runs.

## Vector file format

`mldsa-v2.json` (hex is lowercase, no `0x` prefix — matches the existing
`hkdf-sha256.json` convention):

- `keygen` — 3 cases (seeds `0x07*32`, `0x11*32`, `0x42*32`):
  `{ name, seed, pubkey, secretKey, lockArgs }`, where `lockArgs` is the
  37-byte v2 args `[0x80,0x01,0x01,0x01,0x7A, blake2b_256(pubkey, personal
"ckb-mldsa-sct")]`.
- `cighash` — 3 scenarios (`single-input-empty-witness-fields`,
  `two-inputs-extra-witness`, `first-witness-input-output-type`):
  `{ name, tx, resolvedInputs: [{ cellOutput, data }], groupInputIndices,
stream, digest, finalMessage }`. `tx` is the molecule-packed transaction;
  `stream` is the full CighashAll byte stream (u32-LE length prefixes).
- `sign` — 1 case: seed `0x07*32` over the first scenario's stream:
  `{ name, seed, stream, finalMessage, pubkey, signature, witnessLock }`,
  where `witnessLock = [0x7B, pubkey, signature]` (5262 bytes).
