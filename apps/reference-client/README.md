# @cemp/reference-client

Headless two-user CKB **testnet** reference client proving the full CEMP
message lifecycle end-to-end on a live network (ckd.txt §20 — the milestone
that must pass before the Android UI is connected).

## What it proves

```text
Create Alice from BIP39          Create Bob from BIP39
Create both Profile Cells        Alice discovers Bob (Type ID query)
Alice encrypts + publishes       Bob discovers (route-tag prefix) + decrypts
Bob responds (reply linkage +    Alice discovers + decrypts the response
  downloaded receipt)
Alice reclaims the original      Bob detects the original cell was spent
  message cell                   All balances and local state reconcile
```

Everything runs against the public CKB testnet (AGENTS.md rule 11: testnet
only — never mainnet, rules 11/12) with real transactions, real ML-DSA-65
signatures (v2 lock) and real ML-KEM-768 envelope encryption. Identities are
deterministic throwaways: the mnemonics are hard-coded in
[`src/identities.ts`](src/identities.ts) with a loud warning — never send
real funds to them.

## Run it

```bash
pnpm install && pnpm build          # workspace deps resolve against dist
pnpm --filter @cemp/reference-client client run          # full lifecycle
pnpm --filter @cemp/reference-client client <step>       # or one step
pnpm --filter @cemp/reference-client client run -- --state-dir /tmp/cemp
```

Steps (each checkpoints; re-running resumes where it stopped):

| step          | does                                                                |
| ------------- | ------------------------------------------------------------------- |
| `setup`       | print identities + faucet instructions; gate on funds (exit 2)      |
| `deploy-type` | deploy `contracts/cemp-message-type` as a `data1` code cell (alice) |
| `profiles`    | create both Profile Cells (Type ID args = profile id)               |
| `send`        | alice → bob encrypted text message                                  |
| `receive`     | bob scans his route-tag prefix, validates, decrypts, prints         |
| `respond`     | bob → alice reply with reply_to_outpoint + downloaded receipt       |
| `ack-reclaim` | alice decrypts the response, reclaims her original message cell     |
| `watch`       | bob watches the original cell get spent (history kept, rule 8)      |
| `reconcile`   | balance/state accounting table + assertions (exit 1 on mismatch)    |
| `run`         | all of the above in order                                           |

## Funding

See [FUNDING.md](FUNDING.md). Short version: claim at
<https://faucet.nervos.org> (testnet, 10,000 CKB per claim) — 1 claim each for
alice (she pays the 3,127 CKB contract cell) and bob. `setup` prints the
exact addresses, attempts one best-effort automated claim, polls ~10 min,
then stops with exit code 2 — it never fakes funding or invents
transactions.

## State directory and journals (rules 3, 5, 6, 8)

`--state-dir` (default `./.cemp-state`, gitignored) contains:

- `alice.json` / `bob.json` — per-identity state: derived addresses, balance
  snapshots, fees paid, profile ids, and the local message history. History
  records are **kept** even after a cell is reclaimed (rule 8).
- `shared.json` — step checkpoints, pending broadcasts (crash between
  `send_transaction` and commit ⇒ the resume waits for the recorded hash
  instead of double-broadcasting), the deployment record and the
  message-id → outpoint mappings.
- `journal/<label>.json` — the **pre-broadcast journal** (rule 6): every
  transaction is journaled (unsigned tx + resolved inputs + builder
  metadata) BEFORE `send_transaction` is called.

**Rule 3 note:** plaintext message content is never persisted. Journals and
state hold only ciphertext envelopes, ids, tags, outpoints and capacities;
decrypted text is printed to stdout and nowhere else. Mnemonics live only in
`src/identities.ts` (documented testnet throwaways) and are never logged.

## What changed in the workspace packages

- `CempClient.sendTransaction` (`packages/cemp-ckb/src/client.ts`): the single
  broadcast entry point. The JSON-shaped transaction is re-validated
  field-by-field before it leaves the process; sent with
  `outputs_validator: "passthrough"` because the ML-DSA v2 lock and the CEMP
  type script are not well-known scripts. The journal write always precedes
  the call.
- Builders (`packages/cemp-ckb/src/builders.ts`) now add the script code cell
  deps the chain requires: the Type ID dep on profile creation and the
  deployed `cemp-message-type` dep on message send + reclaim (a type script
  executes on create AND on spend, so its code must be in cell deps).
  `buildDeployDataCellTx` builds the contract code cell.

## Tests

`src/*.test.ts` — offline unit tests (no network): state checkpoint resume
skips completed steps, journal-before-broadcast ordering, reconcile
arithmetic on fixture data. Run repo-wide with `pnpm test`.

## Known deviations from the milestone brief

- Funding minimums are ~8,500/~5,300 CKB, not ~350/~700: occupied capacity
  costs 1 CKB per on-chain byte, and v1 profiles (~3.3 KB) and envelopes
  (~1.7 KB) are large. The first contract build inflated this to ~32,500 CKB
  via a 26.7 KB binary; the raw-syscall rewrite (see below) is 3.0 KB.
- Bob's reconcile formula includes his response message cell capacity (still
  a live, sender-owned protocol cell), which the brief's
  `-(fees + profile capacity)` formula omits.

## 2026-07-17 incident: first contract build was not executable on-chain

The first deployed binary (codeHash `0xb0d8497f…0a0a`, deploy tx
`0x78581966…9647`) validated message cells via
`ckb_std::high_level::load_script` / ckb-gen-types, whose `bytes::Bytes`
refcount clones compile to RISC-V A-extension atomics. CKB-VM implements no A
extension, so `send` died with `VM Internal Error: InvalidInstruction` and
the node rejected the transaction (nothing was broadcast). The contract entry
was rewritten around the raw `load_script` syscall with a hand-rolled
molecule `Script` parse (no ckb-gen-types, no allocation), the broken code
cell was reclaimed (`0x4eaf011a…a880`, `recover-broken-deploy.ts`), and the
fixed binary (codeHash `0xd172d3bf…34b8`, 3,048 bytes, zero A-extension
mnemonics under `riscv64-unknown-elf-objdump -d`) was deployed as
`0x25727f76…17aa5`. The full lifecycle then ran end-to-end — see
`contracts/deployment/cemp-message-type.testnet.json` and the run report.
