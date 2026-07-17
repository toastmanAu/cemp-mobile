# Grounding: CKB knowledge-graph routes

Extracted 2026-07-17 from the local knowledge-graph repository at
`~/ckb-knowledge-graphs` (graph-routing JSON, networkx node-link format; nodes carry
`source_file`/`source_location` provenance and edges carry EXTRACTED/INFERRED/AMBIGUOUS
confidence). These graphs map _source code_, so they answer "where does X live and how
does it connect"; deployment facts live in
[reference-projects.md](reference-projects.md).

Graphs used:

| Graph                 | Nodes | Coverage for this project                                                                                                     |
| --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ckb-mldsa-lock`      | 289   | v1 lock corpus (2026-04-07): C contract, molecule-types, sdk-rust, sdk-js. Pre-dates the v2 locks; use for v1 structure only. |
| `ckb-tx-construction` | 5,820 | ckb-sdk-rust, CCC (`@ckb-ccc/core` signer/client/ckb/molecule), Lumos, ckb-cli. Strong on CCC transaction building.           |
| `ckb-ecosystem-locks` | 2,308 | Lock-script patterns incl. the same ckb-mldsa-lock corpus subset.                                                             |

## Route 1 — ML-DSA lock (graph `ckb-mldsa-lock`)

The graph maps the **v1** implementation end to end:

- Lock args layout documented as `Lock Args Layout (36B)` (node `lock_args_layout`, README.md L17-28).
- Witness path: `parse_mldsa_witness()` (`contract-src/entry.c` L87) → `build_signing_message()`
  (`entry.c` L152) → `mldsa65_verify()` (`contract-src/mldsa_adapter.c` L25); schema in
  `contract-src/mldsa_witness.mol` (node `mldsa_witness_mol`).
- SDK mirrors: sdk-js `signingMessage()` (index.ts L68), `serializeMldsaWitness()` (L86),
  `buildWitness()` (L144), `MldsaKeyPair.signWitness()` (L211), `verify()` (L221);
  sdk-rust equivalents in `crates/sdk-rust/src/lib.rs` L83-195 and
  `crates/molecule-types/src/lib.rs` L36-124.
- The graph also carries an audit node `CRIT-3: size_t witness arithmetic` (entry.c) —
  consistent with the readiness checklist's open fuzzing/bounds items.

Completeness: good for v1 structure; **v2 formats and deployments are not in this graph**
(it was built 2026-04-07 from the pre-v2 corpus). v2 grounding comes from the repo README
— see reference-projects.md §3.

## Route 2 — Transaction construction with CCC (graph `ckb-tx-construction`)

Corpus: `raw/ccc/packages/core/src/{signer,client,ckb,molecule}` (~558 CCC core nodes of
1,199 total CCC nodes). The build/sign route CEMP will use:

- **Transaction model**: `Transaction`, `OutPoint`, `CellOutput` in
  `packages/core/src/ckb/transaction.ts` (L133, L215 …).
- **Coin selection / capacity**: `Transaction.completeInputsByCapacity()` (transaction.ts
  L1996); variants `completeInputs` (L1946), `completeInputsAll` (L2030),
  `completeInputsAddOne` (L2116).
- **Fee**: `Transaction.getFeeRate()` (L2152), `completeFee()` (L2203),
  `completeFeeChangeToLock()` (L2343), `completeFeeBy()` (L2401); guard rails
  `DEFAULT_MIN/MAX_FEE_RATE` + `ErrorClientMaxFeeRateExceeded` (clientTypes).
  cemp-pq used `completeFeeBy(signer, 1200n)` = fixed 1,200 shannons/kB.
- **Witness reservation**: `Transaction.prepareSighashAllWitness()` (transaction.ts L1874) —
  how cemp-pq reserves 5,300 B for the ML-DSA witness before fee completion. For the v2
  lock the reservation is 5,262 B + Molecule WitnessArgs overhead.
- **Type ID**: `hashTypeId()` (`packages/core/src/ckb/hash.ts` L20) — used by cemp-pq's
  profile creation (`ccc.hashTypeId(tx.inputs[0], 0)`).
- **Broadcast**: `client.sendTransaction()` (client.ts L594) / `signer.sendTransaction()`
  (signer/index.ts L458); status via `client.getTransaction()` (L613).

## Route 3 — Cell discovery / indexer / watched outpoints

- **CCC indexer queries**: `client.findCellsPaged()` (client.ts L263), `findCellsOnChain()`
  (L274), `findCells()` (L305), `findCellsByLock()` (L330), `findCellsByType()` (L352);
  signer-side `signer.findCellsOnChain()` / `findCells()` (signer/index.ts L264/293).
  cemp-pq's profile discovery used `client.findCells({script, scriptType:"lock", withData:true})`.
- **Prefix (route-tag) search**: `ClientIndexerSearchKey` / `ClientIndexerSearchKeyFilter`
  (clientTypes.ts L170-265) plus `clientSearchKeyRangeFrom()`
  (clientTypes.advanced.ts L8) — the range-transform trick used to emulate args-prefix
  matching on CKB indexers whose default is exact-args matching. This is the mechanism a
  CEMP route-tag discovery worker needs for type-args = `version || route_tag || …`.
  (Graph note: no explicit `argsSearchMode:"prefix"` node was found — verify against the
  deployed indexer's CKB RPC `get_cells` `args_search_mode` during Phase 7.)
- **Watched outpoint (spent detection)**: no CCC `getLiveCell` node exists in this graph
  (indexer-focused corpus); the underlying primitive is CKB RPC `get_live_cell`, mapped
  here via ckb-cli (`utils/other.rs` L184, `utils/rpc/client.rs` L144, returning
  `IndexerTip`/live-cell status structures). For CCC, confirm the exact client method at
  implementation time; the pattern (poll `get_live_cell` until `dead`) is unaffected.

## Route 4 — Type ID

- ckb-cli `calculate_type_id()` (`utils/other.rs` L365).
- Lumos: `generateTypeIdArgs()` / `generateTypeIdScript()` (`packages/base/src/utils.ts`
  L155/L169), deploy helpers `generateDeployWithTypeIdTx()` / `generateUpgradeTypeIdDataTx()`
  (`packages/common-scripts/src/deploy.ts` L499/L543), resolver refresh
  (`config-manager/src/refresh.ts` L70).
- ckb-sdk-rust example `examples/deploy_script_with_type_id.rs`.
- CCC: `hashTypeId()` (Route 2 above).

CEMP uses Type ID for the stable profile identity (spec §5.3: profile Type ID is the
identity, not a display name) and encounters it operationally because the deployed v2
ML-DSA locks are themselves TYPE-ID-upgradeable cells (mainnet plan drops TYPE ID for
immutable data-hash deps — reference-projects.md §3).

## How to re-query

The graphs are plain JSON at `~/ckb-knowledge-graphs/graphs/<name>/graph.json`
(nodes: `id`, `label`, `source_file`, `source_location`, `community`; links: `source`,
`target`, `relation`, `confidence`). Grep/script them directly, or open the bundled
`graph.html` in a browser for interactive exploration. Regenerate or extend with the
`graphify` tooling if the CCC or lock sources move.
