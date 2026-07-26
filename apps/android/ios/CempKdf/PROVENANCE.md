# CempKdf vendored C core — provenance

`vendor/` is a byte-for-byte copy of `tools/kdf-c-core/vendor/` (see the
README there for the full vendoring notes). It is duplicated into the iOS
tree because the Xcode workspace build must see the sources inside the app
project; `tools/` stays the canonical validation environment (Linux gcc
harness, `run-vectors.sh`).

| Library | Upstream                                   | Pinned at      | Commit                                     | License                                        |
| ------- | ------------------------------------------ | -------------- | ------------------------------------------ | ---------------------------------------------- |
| argon2  | https://github.com/P-H-C/phc-winner-argon2 | tag `20190702` | `62358ba2123abd17fccf2a108a301d4b52c01a7c` | CC0 1.0 / Apache 2.0 (`vendor/argon2/LICENSE`) |
| scrypt  | https://github.com/Tarsnap/scrypt          | tag `1.3.3`    | `041a2126130c3d1e7e2b8facb218c6c017b6890a` | BSD-2-Clause (`vendor/scrypt/COPYRIGHT`)       |

Do not edit these sources. If upstream is re-vendored, update
`tools/kdf-c-core/vendor/` first, re-run `tools/kdf-c-core/run-vectors.sh`,
then re-copy the tree here.

Build notes (mirrored from `tools/kdf-c-core/README.md`):

- argon2 uses the portable reference `ref.c` (not x86 `opt.c`) and is
  compiled with `ARGON2_NO_THREADS=1` (set as a preprocessor definition on
  the Xcode targets; the vault profile is single-lane).
- scrypt uses the self-contained `crypto_scrypt-ref.c`; `sha256.c` is built
  without any `CPUSUPPORT_*` macros (portable software SHA-256 path).
