# docs/protocol

- [CEMP-PROTOCOL-V1.md](CEMP-PROTOCOL-V1.md) — the byte-level wire
  specification (Draft, Phase 1). Normative Molecule schema:
  `packages/cemp-core/schemas/cemp-v1.mol`.

Rule: protocol serialization changes require updating the spec, the schema,
the golden vectors, and the migration/serialization version together
(AGENTS.md rule 1).

Remaining Phase 1 work tracked on the kanban board:

1. Generated/centrally tested codecs for the schema (no hand offsets).
2. Golden serialization vectors, identical in TypeScript and Rust.
3. Fuzz-style malformed-input property tests (spec §12).
