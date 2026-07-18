# tools/protocol-inspector

Offline decoder for CEMP objects (ckb_testnet). Given a cell outpoint, raw
hex, or a file, it classifies and decodes structurally — type args, envelope
structure, profile data, contact bundles, vault files — with optional keyed
payload decryption behind an explicit flag.

**Rule 2 stands.** Nothing prints decrypted payload text without
`--show-plaintext`, and the ML-KEM secret key only ever comes from the
`CEMP_INSPECTOR_SK` environment variable — never argv (argv shows in `ps`).

## Commands

```bash
cd tools/protocol-inspector

# Fetch + classify + decode a live cell (message or profile).
pnpm inspect cell <txHash>:<index> [--rpc <url>]

# Decode an envelope's structure from raw bytes (no decryption).
pnpm inspect envelope <hex|@file>

# Decrypt a payload (structure by default; text only with the flag).
CEMP_INSPECTOR_SK=<kem-secret-key-hex> \
  pnpm inspect payload <hex|@file> --own-profile-id <hex> [--show-plaintext]

# Decode a profile cell's data payload from raw bytes.
pnpm inspect profile <hex|@file>

# Validate + show a scanned contact bundle.
pnpm inspect bundle <json|@file>

# Parse + validate a vault file's structure (params only, no secrets).
pnpm inspect vault <path/to/cemp.vault.json>
```

## Examples

```bash
# Alice's rotated profile cell (testnet).
pnpm inspect cell 0x14c2c036478da403587a556e32b026beba1e1f2b3b1e31174cd533804d33c27e:0x0
# → kind: profile-cell; rotationSequence 1; previousProfileId 0xfa23fbc3…

# A golden-vector envelope, offline.
pnpm inspect envelope "$(python3 -c 'import json; print(json.load(open("../../packages/cemp-test-vectors/vectors/cemp-v1-envelope.json"))["cases"][0]["envelopeBytes"])')"
```

## Design notes

- Total decoders: every command returns a structured view or a structured
  reason — never partial output (rule 4 on live RPC input too).
- Classification is by type script: CEMP message cell (81-byte args, version
  byte 1, reserved-zero shown), Type ID profile cell, or plain data cell.
- Envelope/profile decoding runs the SAME codec validation pipeline as the
  production parsers (`@cemp/core` codec).
- The keyed path (`payload`) decrypts via `decryptEnvelope` and then runs the
  full §12 validation chain (payload + semantic consistency) before showing
  anything.
- Exit codes: 0 ok (including "cell is dead/unknown"), 1 decode/usage error.

Tests: `pnpm test` at the repo root (structural decoders against golden
vectors, classification, keyed-path defaults).
