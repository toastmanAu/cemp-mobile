# ADR 0004: Pin @ckb-ccc/core to 1.12.5 pending a faithful decode path

- Status: Accepted (2026-07-17)
- Context: During the v2 signer port, `@ckb-ccc/core` 1.16.1 failed the
  golden-vector tests: `Transaction.fromBytes` routes decoded outputs through
  `CellOutput.from(decoded, outputData)`, whose automatic capacity
  recalculation silently raises `capacity` to at least the occupied size
  whenever `outputData != null`. Parsing thereby _mutates the transaction
  hash_ — unacceptable in a signing pipeline (and generally: a parser must
  round-trip bytes faithfully). 1.12.5 round-trips all vectors byte-identically.
- Decision: Pin `@ckb-ccc/core` to exactly 1.12.5 (also the version the cemp-pq
  prototype's lockfile resolved). Do not upgrade until CCC offers a
  non-normalizing decode path (or we wrap decode with a capacity-preservation
  guard).
- Consequences:
  - The `packages/cemp-ckb/src/cighash.test.ts` stream byte-equality tests are
    the tripwire: any future CCC upgrade must keep them green before landing.
  - Newer CCC features are unavailable until the pin lifts; nothing in the
    MVP plan needs them.
  - Related defensive rule already in AGENTS.md (rule 4): treat all RPC and
    indexer responses as hostile input — decode-time normalization is one more
    reason to validate, never trust.
