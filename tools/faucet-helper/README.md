# tools/faucet-helper

Testnet faucet utilities: derive a funding address from a development seed,
request testnet CKB, poll until received.

Reference: `reference/cemp-pq/derive-address.js` does the address-derivation
half for the legacy v1 ML-DSA lock; this tool will target the v2 lock format
(see docs/grounding/reference-projects.md §3). Tracked on the kanban board.
