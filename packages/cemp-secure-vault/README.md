# @cemp/secure-vault

Secure wallet vault for CEMP Mobile (spec §4.1, Phase 3). Platform-neutral
TypeScript — runs under Hermes/React Native and Node: no `Buffer`, no
`node:*` imports in the package root. Node-only file storage is exported via
the `./node` subpath so RN bundlers never resolve it.

Implements Phase 3 tasks 1–12: BIP39 12/24-word generation and checksum-
validated import, the encrypted root seed, password and biometric unlock,
auto-lock on inactivity, the authentication-gated reveal and confirmation
quiz, complete wipe, and leak-free errors/logging (AGENTS.md rule 2).

## Multi-slot design

The vault encrypts its secret payload **once** under a random 32-byte **VEK**
(vault encryption key). The VEK is then wrapped independently into _slots_:

- **Slot 1 — password.** KEK = KDF(password, salt, params), AES-256-GCM wrap
  of the VEK. The KDF algorithm and parameters are recorded in the file.
- **Slot 2 — biometric (optional).** `PlatformKeyStore.wrap(VEK,
{ biometric: true })` — an opaque blob only the platform keystore unwraps
  after a biometric prompt.

Because each slot wraps the VEK independently:

- biometrics unlock **without** the password (unwrap blob → VEK → payload);
- **password change is cheap**: re-wrap the 32-byte VEK under a fresh
  salt/nonce — the payload is never re-keyed and the biometric slot is
  carried over untouched (only re-encrypted with a fresh payload nonce
  because the authenticated header changed);
- disabling biometrics removes one slot; the password path is unaffected.

The secret payload is `{ entropy (16|32 B), seed (64 B), hasPassphrase }` in a
fixed deterministic layout. The vault stores **entropy, never the phrase** —
the reveal flow re-derives the words via `entropyToMnemonic`. The BIP39
**passphrase is never stored and cannot be recovered** from the vault; a user
who forgets it must re-import from their written-down phrase.

## Vault file format v1

A single versioned JSON document (`cemp.vault.json`), all byte fields
lowercase hex (no base64, no Buffer). Rule 13: the version, KDF algorithm and
parameters are part of the format.

| Field                          | Type                       | Meaning                                            |
| ------------------------------ | -------------------------- | -------------------------------------------------- |
| `version`                      | `1`                        | Format version. Unknown versions are rejected.     |
| `kdf.alg`                      | `"argon2id"` \| `"scrypt"` | Password KDF for slot 1.                           |
| `kdf.m` / `kdf.t` / `kdf.p`    | int                        | argon2id: memory (KiB) / iterations / lanes.       |
| `kdf.logN` / `kdf.r` / `kdf.p` | int                        | scrypt: log2(N) / block size / parallelization.    |
| `kdf.salt`                     | hex (8–64 B)               | KDF salt, generated at creation / password change. |
| `passwordSlot.nonce`           | hex (12 B)                 | AES-GCM nonce of the password wrap.                |
| `passwordSlot.wrappedVek`      | hex (48 B)                 | VEK(32 B) + GCM tag(16 B) under the KEK.           |
| `biometricSlot`                | object \| `null`           | Opaque keystore blob wrapping the VEK.             |
| `biometricSlot.nonce`          | hex (12 B), optional       | IV when the keystore does not embed it.            |
| `biometricSlot.wrappedVek`     | hex                        | Keystore ciphertext.                               |
| `payload.nonce`                | hex (12 B)                 | AES-GCM nonce of the payload encryption.           |
| `payload.ct`                   | hex                        | Encrypted secret payload + tag under the VEK.      |
| `meta.createdAt`               | epoch ms                   | Creation time (UI hint).                           |
| `meta.wordCount`               | `12` \| `24`               | Mnemonic length (UI hint).                         |
| `meta.hasPassphrase`           | bool                       | A BIP39 passphrase was mixed in at import.         |
| `meta.autoLockSeconds`         | int                        | Inactivity timeout recorded at creation.           |

**Tamper evidence.** The payload's AES-GCM AAD is the canonical JSON of
`{version, kdf, passwordSlot, biometricSlot}` (fixed key order — see
`payloadAad` in `src/format.ts`). Any header edit — KDF salt, parameters,
slot bytes, version — fails payload authentication. The KDF salt is doubly
protected: changing it also derives a wrong KEK. `meta` is deliberately _not_
authenticated: it carries only non-secret UI hints; the authoritative
word-count/passphrase facts live inside the encrypted payload, so a tampered
`meta` can mislabel but never expose key material (`payload.ct` length is
cross-checked against `meta.wordCount` on parse).

**Hostile-input handling** (rule 4). Parsing is strict: shape, lowercase-hex,
length and version checks, and KDF parameters are capped **before any
derivation runs** — argon2id m ≤ 1 GiB / t ≤ 16 / p ≤ 8, scrypt N ≤ 2²⁰ /
r,p ≤ 8, salt 8–64 B — or a crafted file is a memory/CPU denial of service.

## KDF parameters

Spec §14.1: "Argon2id preferred; Scrypt acceptable where implementation
constraints apply."

- **argon2id (default):** m = 64 MiB, t = 3, p = 1 — the RFC 9106 first
  recommended profile, targeted at mid-range Android. Pure-JS argon2 under
  Hermes is slow at desktop parameters; **Android builds may create `scrypt`
  vaults where argon2 proves too costly** — the file records whichever
  algorithm and parameters were used, so unlock is algorithm-agnostic.
- **scrypt (recorded alternative):** logN = 17, r = 8, p = 1 (N = 131072),
  matching the key-vault-wasm reference constraints
  (`docs/grounding/reference-projects.md`).

Creation options (`CreateVaultOptions.kdf`) may override individual cost
parameters; the file records exactly what was used. Tests use tiny
parameters for speed — never do this in production builds.

Passwords are UTF-8 encoded as typed, with **no Unicode normalization**: the
same byte sequence must be re-typed to unlock (mobile input methods are
deterministic here).

## Security model

- **Attacker with the vault file but no password:** nothing. The payload is
  AES-256-GCM under a random VEK; the VEK is wrapped under a KDF-derived KEK
  (offline brute-force cost set by the recorded parameters) and/or a
  platform-keystore blob. Header tampering is detected by the payload AAD.
- **Reinstall without the mnemonic cannot recover the wallet.** The vault
  file alone is undecryptable; the `cemp.dbkey` blob and biometric slot are
  undecryptable without the platform key, which a reinstall destroys
  (modelled by `EphemeralSoftwareKeyStore`: a new instance can never unwrap
  old blobs, and `deleteKey()` kills all prior blobs).
- **Locking removes usable key material from ordinary application state.**
  `lock()` zeroizes the VEK, the decrypted payload, the seed and the cached
  database key (`.fill(0)`, best-effort). JavaScript limits are documented in
  the `src/vault.ts` header: stale typed-array backing stores, GC copies and
  immutable strings (passwords, mnemonic phrases) cannot be guaranteed wiped
  from JS — hardening is a later phase.
- **Errors are indistinguishable where they must be.** Wrong password and a
  corrupt/tampered payload are both AES-GCM authentication failures; the
  password path maps both to `wrong-password`. Error messages and causes
  never carry mnemonics, seeds, keys, passwords or plaintext (rule 2), and
  mnemonic-import failures forward no library `cause` (library messages can
  embed phrase fragments).
- **Borrowed buffers.** `withUnlockedSeed` and `getDatabaseKey` hand out
  references to live, zeroize-on-lock buffers — callers must copy anything
  they retain and must never stash the reference. `unwrapDatabaseKey`
  returns a caller-owned copy instead.

## Platform mapping (rule 14)

The vault talks to platforms only through two interfaces:

- **`PlatformKeyStore`** (`src/keystore.ts`): wraps the biometric slot and
  the database-key blob. The Android Keystore implementation (hardware-backed
  key with `setUserAuthenticationRequired(true)` for the biometric slot)
  ships in `apps/android` in a later phase; the iOS Keychain/Secure Enclave
  slot is reserved by the same interface. This package ships
  `EphemeralSoftwareKeyStore`, a process-lifetime reference implementation
  for tests and desktop development — **not a secure keystore**.
- **`VaultStorage`** (`src/storage.ts`): two opaque byte objects,
  `cemp.vault.json` and `cemp.dbkey`. `MemoryVaultStorage` serves tests;
  `FileVaultStorage` (atomic tmp+rename writes, mode 0600) is exported from
  `@cemp/secure-vault/node` for Node/desktop tooling; React Native
  persistence plugs in behind the interface in `apps/android`.

## What later phases consume

- **Phase 6 (local database):** `getDatabaseKey()` (derived from the live
  seed via `deriveLocalDatabaseKey` — no post-quantum keygen on the unlock
  path) and `unwrapDatabaseKey()` (the same 32 bytes unwrapped from the
  persisted `cemp.dbkey` blob). Both are unlocked-only and byte-identical.
  The unwrapped key is never persisted — the database cannot be opened
  without the wrapped key.
- **Phase 4+ (identity):** `withUnlockedSeed(seed => deriveIdentityKeys(seed))`
  — the vault owns the seed; identity derivation borrows it.

## Golden vectors

`packages/cemp-test-vectors/vectors/cemp-vault-v1.json` holds deterministic
v1 files (argon2id 12-word and scrypt 24-word cases) plus the expected
mnemonic/seed/database-key, so other runtimes can conformance-test parsing,
unlock and byte-for-byte reproduction. Regenerate with:

```bash
pnpm --filter @cemp/secure-vault exec tsx src/vectors-generate.ts
```

Regeneration must be byte-identical — drift means the format, KDF wiring or
AEAD changed, and format version, spec and vectors must move together
(AGENTS.md rule 1). The `cemp.dbkey` blob is deliberately excluded: it is
keystore-implementation-specific and not deterministic across platforms.
