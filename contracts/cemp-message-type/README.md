# cemp-message-type

The CEMP message type script: a minimal CKB type script that validates the
81-byte discovery args of every message cell carrying it, so malformed cells
cannot squat under the CEMP code hash (protocol spec
`docs/protocol/CEMP-PROTOCOL-V1.md` §6).

## Type args (81 bytes, fixed)

```text
version            u8         = 1
route_tag          [u8; 32]
conversation_tag   [u8; 16]
message_nonce      [u8; 16]
```

Note: the spec §2 field sizes sum to 65 bytes; spec §6 normatively pins the
total at 81 ("Type args (81 bytes, fixed)"), which is what this script
enforces. The 16-byte gap is tracked as a spec discrepancy — tightening the
field split is a spec-level change (AGENTS.md rule 1).

## Behaviour

Running as a TYPE script, it executes once per group of cells sharing the
type (on cell creation and on spending); per-cell args are identical by
construction (same script), so validating the script's own args covers the
group. v1 deliberately does not load cell data (cycle cost near zero);
envelope shape is validated client-side per protocol spec §12.

Exit codes:

| code | meaning                                          |
| ---- | ------------------------------------------------ |
| 0    | success                                          |
| 1    | type args length != 81 bytes                     |
| 2    | unsupported protocol version byte (args[0] != 1) |
| 3    | failed to load own script                        |

## Layout

- `src/lib.rs` — `no_std`, platform-neutral validation logic
  (`validate_type_args`) plus shared constants; unit-tested on the host.
- `src/main.rs` — CKB-VM entry point, compiled only for riscv64; host builds
  get a no-op `main`. `ckb-std` is a target-specific dependency
  (`cfg(target_arch = "riscv64")`), so host `cargo test` never compiles it.

## Build (on-chain binary)

```bash
rustup target add riscv64imac-unknown-none-elf   # once
cargo build --target riscv64imac-unknown-none-elf --release
```

or run `./build.sh`, which additionally prints the size and code hash.

Output: `../target/riscv64imac-unknown-none-elf/release/cemp-message-type`.

Current build (rustc 1.92.0, ckb-std 1.1.0, workspace release profile
`lto = true, opt-level = "s"`):

- size: 3048 bytes
- codeHash (blake2b-256, `ckb-default-hash` personalization; Python
  `hashlib.blake2b(person=...)` agrees):
  `0xd172d3bfb46d2e2f8f0e1c24139d3851010776205d66cec235dca34ec52234b8`

⚠ The first build (26672 bytes, codeHash `0xb0d8497f…0a0a`) was deployed and
then reclaimed the same day: its `ckb_std::high_level::load_script` /
ckb-gen-types path cloned `bytes::Bytes` refcounts, which compile to RISC-V
A-extension atomics (`lr.d`/`sc.d`/`amoadd.d`) that CKB-VM does not implement
— the script died with `VM Internal Error: InvalidInstruction` on its first
message-cell validation. `src/main.rs` now uses the raw `load_script` syscall
and hand-parses the molecule `Script` table; the binary must stay free of
`lr.*`/`sc.*`/`amo*` mnemonics (check with `riscv64-unknown-elf-objdump -d`).

The codeHash is a function of the exact toolchain and dependency set; rebuilds
with different versions may produce a different hash. Deployment must record
the hash of the binary it actually ships — see `contracts/deployment/README.md`.

## Test

```bash
cargo test   # from contracts/ workspace root; host-side, no riscv toolchain needed
```

Covers: valid 81-byte v1 args accepted; lengths 80/82/0 rejected; version
byte != 1 rejected; placeholder constants kept in sync with `cemp-core`.
