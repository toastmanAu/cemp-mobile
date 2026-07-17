# tools/protocol-inspector

Offline decoder for CEMP cells and envelopes: given a tx hash or raw cell
data, parse the type args (version / route_tag / conversation_tag / nonce),
validate envelope structure and size limits, and pretty-print — without
attempting decryption.

Becomes useful from Phase 7 (text message publication) onward. Tracked on the
kanban board.
