# Grounding: reference projects

Verified facts from the three supplied/reference codebases, gathered 2026-07-17
by direct inspection of the local checkouts. Sources:

| Project        | Local path                                                                                              | Notes                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| cemp-pq        | `~/chain-pay/packages/cemp-pq` (library code, newer) + `~/ecms/cemp-pq` (docs, live-test, verification) | Vendored into [`/reference/cemp-pq`](../../reference/cemp-pq/)                                 |
| key-vault-wasm | `~/code/key-vault-wasm`                                                                                 | `quantum-purse-key-vault` 0.4.0, branch `feat/mldsa65-cighash`, last commit 2026-04-08         |
| ckb-mldsa-lock | `~/ckb-mldsa-lock`                                                                                      | Last commit 2026-07-08; README + `docs/trust-model.md` + `docs/mainnet-readiness-checklist.md` |

---

## 1. cemp-pq (the prototype)

### Which copy is canonical

Neither copy supersedes the other: chain-pay's `package.json` says "vendored from
~/ecms/cemp-pq" and contains **newer library code** (network-parameterized lock
constants, `getMlDsaConstants(network)`, full profile fetch, and the
notification-pointer fix — a 52-byte zero placeholder in `outputsData[1]` before
`completeFeeBy`, overwritten with the real `MessagePointer` after fee completion).
ecms is canonical for README, live-test harness, and on-chain verification records.
`schemas/cemp-pq.mol` is byte-identical. Total size ~700 LOC JS + schema — vendored
wholesale under `reference/cemp-pq/`.

### Dependencies (both copies identical)

- `@ckb-ccc/core ^1.12.0` (lockfile pins **1.12.5**)
- `@noble/hashes ^1.8.0` (1.8.0)
- `@noble/post-quantum ^0.2.1` (0.2.1)
- Notable transitives of CCC 1.12.5: `@joyid/ckb 1.1.4`, `ethers 6.16.0`, `@nervosnetwork/ckb-sdk-utils 0.109.5`

### Crypto implementation (`index.js`, `tx-builder.js`)

- **ML-KEM-768**: `ml_kem768` from `@noble/post-quantum/ml-kem`.
  `CEMPPQ.encrypt` (`index.js:197`): `ml_kem768.encapsulate(pk)` → `{cipherText, sharedSecret}`;
  `CEMPPQ.decrypt` (`index.js:227`): `ml_kem768.decapsulate(kemCt, sk)`.
- **Symmetric key**: `blake2b(sharedSecret, {dkLen:32, personalization:"CEMP-PQ-SYM-KEY_"})`
  — raw BLAKE2b, **not HKDF** (must be replaced per spec §14.1).
- **AES-256-GCM**: Web Crypto `crypto.subtle`, 12-byte random nonce, tag appended by subtle.
- **ML-DSA-65**: `ml_dsa65` from `@noble/post-quantum/ml-dsa`.
  `MLDSASigner extends ccc.Signer` (`tx-builder.js:12`): 32-byte seed → `ml_dsa65.keygen(seed)`;
  `signOnlyTransaction` (`tx-builder.js:66`): `ml_dsa65.sign(secretKey, signingMessage(tx.hash()), ctx="CKB-MLDSA-LOCK")`.
- **Signing digest** (`index.js:129`): `signingMessage(txHash)` = blake2b-256
  (personal `ckb-default-hash`) of `"CKB-MLDSA-LOCK" || txHash`. **Covers the tx hash
  only, not sighash-all** — matches the v1 lock's documented HIGH-1 gap (§3 below).
- **Witness**: hand-rolled Molecule — `serializeMldsaWitness` (6-field table:
  version/algo_id/param_id/flags + Bytes(pubkey 1952) + Bytes(sig 3309) = 5,301 B)
  wrapped by `buildWitness` into a WitnessArgs table with only `lock` set (5,321 B total).
  `prepareTransaction` reserves 5,300 B via `tx.prepareSighashAllWitness(this.script, 5300, client)`.
- **v1 lock args (36 B)**: `[0x01 version, 0x02 algo_id, 0x02 param_id, 0x00, ckb_blake2b_256(pubkey)]`
  (`tx-builder.js:24-37`). v2 locks use a different 37-byte format (§3).

### Molecule schemas (`schemas/cemp-pq.mol`)

Tables: `EncryptedMessage{kem_ciphertext, nonce, ciphertext}`,
`MessagePointer{tx_hash: Bytes, index: uint32}`, `Receipt{message_hash: Bytes, status: byte}`,
`Profile{ml_dsa_public_key: Bytes(1952), ml_kem_public_key: Bytes(1184), metadata: Bytes}`.
Serialization is **hand-written LE-u32 Molecule** in `index.js` — no moleculec codegen.

### Testnet flow, endpoints, deployed identifiers

- Client: `ccc.ClientPublicTestnet()` → RPC `https://testnet.ckb.dev/`
  (WS `wss://testnet.ckb.dev/ws`), indexer `https://testnet.ckbapp.dev/`; address prefix `ckt`.
- **Legacy v1 ML-DSA lock constants** (`index.js:14`):
  - code_hash `0x8984f4230ded4ac1f5efee2b67fef45fcda08bd6344c133a2f378e2f469d310d`, hash_type `type`
  - cell dep out point tx `0xba4a6560ef719b24d170bf678611b25b799c56e6a80f18ce9c79e9561085cba7` index `0`, depType `code`
  - **Deprecated** (HIGH-1 sighash gap; deploy owner's key lost → immutable).
- **Profile creation** (`buildCreateProfileTx`, `tx-builder.js:111`): one output with the
  sender's ML-DSA lock + placeholder Type ID type script (codeHash = ASCII "TYPE_ID", zero args);
  `outputsData[0]` = serialized Profile; `completeInputsByCapacity` →
  `typeIdArgs = ccc.hashTypeId(tx.inputs[0], 0)` → `completeFeeBy(signer, 1200n)`.
- **Message send** (`buildSendMessageTx`): `fetchRecipientProfile` scans
  `client.findCells({script: recipientLock, scriptType:"lock", withData:true})` and picks the
  first cell whose type codeHash is the TYPE_ID system hash, parsing Profile by offsets.
  Output 0 = message cell **owned by the sender** (data = EncryptedMessage envelope);
  output 1 = **notification cell owned by the recipient** (data = 52-byte
  `MessagePointer{tx_hash = tx.hash(), index = 0}`). Fee rate default 1,200 shannons/kB.
- **Verified on-chain 2026-05-29** (`verify-txs.js`): profile create
  `0x765d3d9019335ea221590f61b0ce9c82cd29b7514b6cc638af6584f19a15e7ed` (committed);
  message+notification `0x224eee0549fac21f063bd5d971bb0eb779da8d5c7125e95825cd784f3c579a7d` (committed).

### Prototype shortcuts (do not carry into production)

1. v1 lock + tx-hash-only digest (HIGH-1).
2. Raw personalised BLAKE2b as message KDF — replace with specified HKDF (spec §14.1).
3. Recipient-owned notification cell — conflicts with sender reclamation; spec §6
   replaces it with sender-owned cells + recipient-indexable type args.
4. No BIP39/HKDF key derivation — raw demo seeds (`0x07…` fills in `live-test.js`).
5. Hand-written Molecule with scattered offsets.
6. `CEMP_PQ_PROFILE_CODE_HASH = 0x…0001` unused placeholder; profile discovery relies
   on Type ID presence, not a protocol type script.

---

## 2. key-vault-wasm (`quantum-purse-key-vault` 0.4.0)

Rust → wasm-bindgen cdylib. Outer crate `src/` ~1,770 LOC plus
`crates/ckb-fips205-utils` (SPHINCS+) and `crates/ckb-fips204-utils` 0.2.0 (ML-DSA + Falcon).

**Patterns worth porting to `packages/cemp-secure-vault`:**

- **Scrypt** `derive_scrypt_key` (`utilities/mod.rs:39`); params `log_n=17, r=8, p=1, len=32`
  (`constants.rs:35`). Spec §14.1 prefers Argon2id; Scrypt acceptable under constraints.
- **AES-256-GCM vault encryption** (`utilities/mod.rs:83/115`): fresh 16 B salt + 12 B IV
  per encryption, key = scrypt(password, salt), `CipherPayload{salt, iv, cipher_text}` hex.
- **HKDF-SHA-256, no salt, domain via info** (`utilities/mod.rs:61`); ML-DSA path
  `"ckb/quantum-purse/ml-dsa/{variant}/{index}"` → 32-byte ξ → `fips204 ml_dsa_65::KG::keygen_from_seed`
  (deterministic keygen from seed — verify against `@noble/post-quantum` during Phase 2).
- **IndexedDB** (`db/mod.rs`): `indexed_db_futures 0.6.4`, DB v2, stores
  `master_seed_store` / `child_keys_store` / `ml_dsa_keys_store`. Browser-only — Android
  needs a different storage backend (encrypted file + Keystore wrap).
- **Secure buffers**: `SecureVec` zeroize-on-drop (implements `aes_gcm::aead::Buffer`);
  `SecureString::from_uint8array` zeroes the caller's JS `Uint8Array`.

**Do not reuse:** the custom 36/54/72-word mnemonic (3 concatenated standard mnemonics,
built for SPHINCS+' 48/72/96 B seeds). Spec §5.1 mandates standard 12/24-word BIP39.

**v2 ML-DSA support exists here:** 0.4.0 bolted on an ML-DSA store + signing via
`ckb-fips204-utils` (`gen_new_ml_dsa_account`, `sign_ml_dsa`, `get_ckb_tx_message_all`).
Stale docs claim 36 B args / 5,305 B witness; the actual v2 code emits **37-byte args**
and a **5,262-byte raw `[flag, pk, sig]` witness** matching ckb-mldsa-lock v2.

---

## 3. ckb-mldsa-lock

### Deployment status (from README, verified 2026-07-17)

**8 v2 locks live on CKB testnet**, all `hash_type: "type"` (TYPE ID, upgradeable),
smoke-spent on-chain. Testnet only, unaudited. The canonical pick is **mldsa65-lock-v2-rust**:

| Variant                              | code_hash                                                                |
| ------------------------------------ | ------------------------------------------------------------------------ |
| mldsa44-lock-v2 (fips204)            | `0x1e9798b5545214d7c6bf9a23564847b671c40f3f91536608e7c2eadf782ba237`     |
| mldsa65-lock-v2 (fips204)            | `0xda3e5dc140c25b62ba0697fa83dc866e6c8e29eba4d9d91df5735bf4f06960a7`     |
| mldsa87-lock-v2 (fips204)            | `0x37dc2a33c484de9b2378a07f926e78083e53a0322bc05e78681bb47510607e15`     |
| mldsa44-lock-v2-rust                 | `0x52acc41edd9218617e164555d99d2830292754c79370b61bee4e5f0e89d34756`     |
| **mldsa65-lock-v2-rust (canonical)** | **`0xd70653f7fd51e173ec506b76081f37bf4acebb8a15dc79e6d4ad43ca4d3b78a4`** |
| mldsa87-lock-v2-rust                 | `0x70021f94a11de672edd16bdb2f577cb2178cd8581080c951513e8650cfca033c`     |
| falcon512-lock-v2                    | `0xbf949c7980454296ca2d537471fd86b746f5fa86df50533644d10c9b06a2fbd4`     |
| falcon1024-lock-v2                   | `0xbf26aaceee7237aad36e984c04917dc0d94ee46d6a84965063509729716cfd10`     |

⚠️ These code hashes are script hashes. The TYPE_ID discriminator in `type.args` is a
_different_ 32 bytes; using it as code_hash makes unspendable cells (README warning).

Deploy txs (use as `cell_dep`, `dep_type: code`):

- **Session 10 (current, 5 Rust cells, overflow-checks on)**:
  `0x1074b1ac79213c22b5e32a0fde44a858a47f9575c9f54006a1deb80d32070cb1`, block 20,716,841 —
  falcon512 @ 0, falcon1024 @ 1, mldsa44-rust @ 2, **mldsa65-rust @ 3**, mldsa87-rust @ 4.
- Session 9 (3 fips204 C cells): `0x39b1c11ed7ca2e4a0491c69d105ee07e5659e88109661d4b48f2ff39a45cf1f1` — mldsa44/65/87 @ 0/1/2.
- mldsa65-rust proof-of-life spend: `0x13404ea7597ae11f243df674c106c37b9eef40e5e251bac54ee4d185d03f8c88`.
- **Legacy v1** (what cemp-pq uses): code_hash
  `0x8984f4230ded4ac1f5efee2b67fef45fcda08bd6344c133a2f378e2f469d310d`, deploy tx
  `0xba4a6560ef719b24d170bf678611b25b799c56e6a80f18ce9c79e9561085cba7` index 0,
  data_hash `0x7dcb281583da642016be3a0a4a4d7d4c4d573df2ae10cd4fb4d1616d74007725`.
  Deploy owner's key lost → effectively immutable; **deprecated (HIGH-1)**.
- Deploy owner (trust root for all v2 cells): secp256k1-blake160
  `code_hash 0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8`,
  `args 0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7`, `hash_type type`.

### Formats

- **v2 lock args (37 B)**: `[0x80, 0x01, 0x01, 0x01, flag=(param_id<<1)|0, blake2b_256(pubkey)]`,
  blake2b personal `ckb-mldsa-sct`. ParamIds: Mldsa44=60, Mldsa65=61, Mldsa87=62,
  Falcon512=63, Falcon1024=64.
- **v2 witness lock**: `[flag=(param_id<<1)|1, pubkey, signature]` — mldsa65 =
  1+1952+3309 = **5,262 B** (confirms the "~5.3 KB" figure).
- **v2 signing digest**: full **CighashAll** stream (all input cells + their data, group
  witness's input_type/output_type, all other witnesses; lock field excluded) → blake2b
  personal `ckb-mldsa-msg` → FIPS-204 §5.4 M' wrap with `DOMAIN = "CKB-MLDSA-LOCK"`.
  On-chain: `ckb_fips204_utils::ckb_tx_message_all_in_ckb_vm`; host mirror:
  `ckb_tx_message_all_host` (`host-hashing` feature). ⚠️ fips204-backend and
  RustCrypto-backend locks are **not signature-cross-compatible** (different M' framing)
  though pubkeys/lock_args match.
- **The v1 caveat (HIGH-1)** — `contracts/mldsa-lock/src/entry.c:21`: _"The signing digest
  covers tx_hash only, not all witnesses… does not implement the full RFC-0024 sighash-all
  covering co-signed witnesses."_ This is exactly what cemp-pq and the v1 JS SDK implement.
- Cycle budget (70M/script limit): mldsa65-rust 6.15M; mldsa65-fips204 10.24M.

### v1 vs v2 incompatibility (end-to-end)

|           | v1 (legacy)                                            | v2 (current)                    |
| --------- | ------------------------------------------------------ | ------------------------------- |
| lock args | 36 B                                                   | 37 B                            |
| witness   | Molecule `MldsaWitness` table (5,321 B in WitnessArgs) | raw `[flag, pk, sig]` (5,262 B) |
| digest    | tx_hash only                                           | full CighashAll stream          |
| JS SDK    | exists (`sdk/js`, `@ckb-mldsa/sdk` 0.1.0)              | **does not exist**              |

The v2 signing path currently exists only in Rust: `tests/integration/src/bin/mldsa65_spend_test`
(host-side CighashAll via `generate_ckb_tx_message_all_host`) and key-vault-wasm's
wasm-callable `ckb-fips204-utils`. **Implication for CEMP Mobile: the Phase 4 signer
adapter must either port CighashAll to TypeScript (with golden vectors from the Rust
host mirror) or call into Rust/WASM.** This is a mainnet gate item (spec §14.3) but also
blocks using the v2 lock on testnet.

### Mainnet readiness (docs/mainnet-readiness-checklist.md, 2026-04-10)

Mainnet plan = immutable data-hash dep cells, no TYPE ID (a secp256k1 upgrade authority is
a quantum-breakable trust root over PQ verifiers). Only checked item: overflow-checks=true.
Open: witness-parse fuzzing, deserialization bounds audit, cargo-careful/miri, NIST ACVP
KATs, differential testing across backends, malleability audit, external review, glue-code
review, core-dev sign-off, reproducible builds, RFC-style byte-exact spec, migration guide
(`hash_type: type` → `data1`), merge freeze, key ceremony, on-chain monitoring.

---

## Cross-codebase conclusions for CEMP Mobile

1. **Testnet identity/wallet target: mldsa65-lock-v2-rust** (code_hash
   `0xd70653f7…78a4`, deploy tx `0x1074b1ac…0cb1` index 3), not the v1 lock the
   prototype used. Business logic must keep lock deployment configurable (spec §3).
2. **A v2 JS/TS CighashAll signer must be built** (Phase 4 critical task). The Rust
   `ckb_tx_message_all_host` mirror is the reference; cross-check with golden vectors.
3. **HKDF replaces the prototype's personalised-BLAKE2b KDF** — implemented in
   `packages/cemp-crypto` (RFC 5869 vector tested).
4. **Vault patterns** (Scrypt/AES-GCM/HKDF/zeroize) port from key-vault-wasm; its
   IndexedDB layer and SPHINCS+ mnemonic do not.
5. cemp-pq's `MessagePointer` receipt and profile-on-Type-ID discovery patterns are
   worth reusing conceptually, inside the revised sender-owned cell model (spec §6).
