# docs/protocol

Home of `CEMP-PROTOCOL-V1.md` — the byte-level wire specification written in
**Phase 1** (ckd.txt §18). Until it exists, `packages/cemp-core` holds only the
logical structure (envelope/payload fields, state machines, limits).

Phase 1 deliverables for this directory:

1. Byte-level definition of: Profile, Message envelope, Encrypted payload,
   Receipt, Attachment manifest, Reclaim group.
2. Generated or centrally tested Molecule codecs (no scattered hand offsets).
3. Strict maximum field lengths; malformed-input behaviour.
4. Protocol version + algorithm identifiers on every serialized object.
5. Golden serialization vectors (TypeScript ↔ Rust), kept in
   `packages/cemp-test-vectors`.
6. Documented metadata-leakage analysis (see also ../threat-model/).

Rule: protocol serialization changes require updating the spec here, the
golden vectors, and the migration version together (AGENTS.md rule 1).
