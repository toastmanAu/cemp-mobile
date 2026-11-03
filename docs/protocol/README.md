# docs/protocol

- [CEMP-PROTOCOL-V1.md](CEMP-PROTOCOL-V1.md) — the byte-level wire
  specification (Draft, Phase 1). Normative Molecule schema:
  `packages/cemp-core/schemas/cemp-v1.mol`, plus the protocol-version-2
  additions in `cemp-v2.mol` (ADR 0006, spec §9.1).
- [CEMP-ENVELOPE-V3.md](CEMP-ENVELOPE-V3.md) — protocol version 3, the
  sender-signed envelope (ADR 0007). Normative schema: `cemp-v3.mol`. All
  sends are v3; v1/v2 are received as "Unverified (legacy)".

Rule: protocol serialization changes require updating the spec, the schema,
the golden vectors, and the migration/serialization version together
(AGENTS.md rule 1).

Remaining Phase 1 work tracked on the kanban board:

1. Generated/centrally tested codecs for the schema (no hand offsets).
2. Golden serialization vectors, identical in TypeScript and Rust.
3. Fuzz-style malformed-input property tests (spec §12).
