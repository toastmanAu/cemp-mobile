# kdf-c-core — C KDF core for the iOS `CempKdf` native module

The C implementations of the vault password KDFs (argon2id and scrypt) that
the future iOS native module (`CempKdf`, Swift wrapper) will embed, vendored
from their official sources and **vector-validated on Linux** against the
repo's existing KDF known-answer tests.

Cross-references:

- `packages/cemp-secure-vault/src/kdf.test.ts` — source of truth for the
  vectors (pinned expected outputs, parameters, passwords, salts). The TS
  implementation (`kdf.ts`, `@noble/hashes`) is the reference engine.
- `docs/architecture/ios-prep.md` (Task 2) — iOS needs a native KDF module
  because pure-JS memory-hard KDFs are too slow under Hermes. The iOS engine
  must produce **byte-identical output** to the TS engine; this directory is
  the conformance gate for the C core it will wrap.

## Layout

```
harness.c        CLI: reads vectors.txt, runs each case, PASS/FAIL + exit code
vectors.txt      the vector cases, extracted verbatim from kdf.test.ts
run-vectors.sh   builds with plain gcc and runs the harness (exit 0 = all PASS)
vendor/argon2/   phc-winner-argon2 reference library (subset)
vendor/scrypt/   Tarsnap scrypt reference implementation (subset)
```

## Vendored sources

| Library | Upstream | Pinned at | Commit | License |
|---|---|---|---|---|
| argon2 | https://github.com/P-H-C/phc-winner-argon2 | tag `20190702` | `62358ba2123abd17fccf2a108a301d4b52c01a7c` | CC0 1.0 / Apache 2.0 (dual; see `vendor/argon2/LICENSE`) |
| scrypt | https://github.com/Tarsnap/scrypt | tag `1.3.3` | `041a2126130c3d1e7e2b8facb218c6c017b6890a` | BSD-2-Clause (see `vendor/scrypt/COPYRIGHT`) |

Both were fetched with `git clone --depth 1 --branch <tag>` and trimmed to
the files needed to build; `.git`, tests, build systems, and docs were
removed. License files were kept. Do not edit vendored sources — re-vendor
from upstream instead.

argon2 subset notes:

- `src/ref.c` (the portable reference `fill_segment`) is used, not `src/opt.c`
  (x86 SSE) — iOS targets ARM and the output is identical either way.
- Built with `-DARGON2_NO_THREADS`: the vault profile is single-lane (p=1),
  so no pthread is needed.

scrypt subset notes:

- `lib/crypto/crypto_scrypt-ref.c` is the self-contained reference
  implementation (only needs `sha256` + `sysendian`), avoiding the
  `lib-platform` variant's configure-generated `platform.h`/`config.h`.
- `libcperciva/alg/sha256.c` is built **without** any `CPUSUPPORT_*` macros,
  so it takes the portable software SHA-256 path (no SHANI/SSE2/ARM runtime
  detection files required). The output is identical on every path.

## Build and run

```sh
tools/kdf-c-core/run-vectors.sh
```

Plain `gcc -O2 -std=c99`, no dependencies beyond libc. Prints `PASS`/`FAIL`
per case and exits non-zero on any mismatch. Current status: **4/4 PASS**
(the 4 known-answer cases from `kdf.test.ts`).

Ad-hoc (not committed to `vectors.txt`, which mirrors `kdf.test.ts` only):
the harness was also run at full production strength against expected outputs
computed fresh from `packages/cemp-secure-vault/src/kdf.ts` — argon2id
m=65536/t=3/p=1 and scrypt logN=17/r=8/p=1 both matched the noble JS engine
byte-for-byte on this Linux box.

## Parameter sets (what the Swift wrapper must replicate)

Production vault profiles (defaults in `packages/cemp-secure-vault/src/kdf.ts`):

- **argon2id** (RFC 9106, first recommendation): `m = 65536` KiB (64 MiB),
  `t = 3`, `p = 1`
- **scrypt** (RFC 7914, key-vault-wasm profile): `logN = 17` (N = 131072),
  `r = 8`, `p = 1`

Both derive a **32-byte** KEK (`KEK_BYTES`). Parameters are recorded in the
vault file header, so the module must accept arbitrary (validated) values —
the vector file exercises m=32/t=2 and RFC 7914's logN=4/r=1/p=1 and
logN=10/r=8/p=16 cases too.

Subtleties the Swift bridge must get right (all encoded in `harness.c`):

- argon2: call `argon2_hash(..., Argon2_id, ARGON2_VERSION_NUMBER)` —
  **version 0x13 (v1.3)**, type **argon2id**, no secret, no associated data,
  `ARGON2_DEFAULT_FLAGS` (clears password + memory). `m_cost` is in **KiB**.
- scrypt: the vault file stores `logN`; the C API takes
  `N = (uint64_t)1 << logN`.
- scrypt `dkLen = 32`: the RFC 7914 §12 vectors are published with dkLen=64;
  scrypt's final PBKDF2 block 1 is dkLen-independent, so the 32-byte KEK is
  the **32-byte prefix** of the published 64-byte outputs (see the comment in
  `kdf.test.ts`).
- Password bytes: raw UTF-8 as typed, **no NFKC normalisation**.
- Bridge surface: lowercase hex in (password, salt), lowercase hex out
  (derived key) — the same `{ argon2id, scrypt } → hex` surface the Android
  `CempKdf` module exposes. Wipe password buffers after use.

## Status / future work

The C core is validated on Linux. Remaining work is macOS-host only: the
Swift wrapper module and the `apps/ios` build integration
(`docs/architecture/ios-prep.md`, "What this preparation deliberately does
NOT do").
