# Grounding docs

Facts verified against source code and local knowledge graphs before
implementation began. Treat these as the factual substrate under the spec
(`ckd.txt`); when the two disagree, the spec is the product intent and these
docs describe what actually exists on-chain and in code.

- [reference-projects.md](reference-projects.md) — cemp-pq prototype,
  key-vault-wasm, ckb-mldsa-lock: deployments, formats, incompatibilities,
  reusable patterns, and the cross-codebase conclusions that shape Phases 1–4.
- [ckb-knowledge-graph-routes.md](ckb-knowledge-graph-routes.md) — ML-DSA lock,
  CCC transaction construction, indexer/route-tag discovery, and Type ID
  routes traced through `~/ckb-knowledge-graphs` with node-level citations.
