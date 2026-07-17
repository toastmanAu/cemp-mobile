# Funding the reference client (CKB **testnet** only)

The reference client uses two deterministic throwaway identities (see
`src/identities.ts` — the mnemonics are public, NEVER send real funds).
One faucet claim (10,000 CKB) per address covers the whole lifecycle.

| identity                          | address                                                                                                                        | minimum (spendable)  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| alice (also deploys the contract) | `ckt1qrtsv5lhl4g7zulv2p4hvzqlx7l54n4m3g2ac70x6jk58jjd8du2gqvqqyqsz7h2g90squ8wskxfuan2fzjy99y5l6qdhmtmdzdywyey87e4u3hpzce6wnlc` | ~8,500 CKB (1 claim) |
| bob                               | `ckt1qrtsv5lhl4g7zulv2p4hvzqlx7l54n4m3g2ac70x6jk58jjd8du2gqvqqyqsz73688mg9u3uqjus70k6t9vf6k4kwcqygpjcuhslcmngjyxv06fylqfc457u` | ~5,300 CKB (1 claim) |

## How to fund

1. Open <https://faucet.nervos.org> in a browser.
2. Paste one of the addresses above into the address field.
3. Keep the network on **Testnet**, solve the captcha, press **Claim**.
4. Repeat for the other address, then re-run:

   ```bash
   pnpm --filter @cemp/reference-client client setup
   ```

`setup` also tries one best-effort automated claim via the faucet's HTTP API
and then polls for up to ~10 minutes before stopping with exit code 2.

## Why the minimums are what they are

Occupied capacity costs 1 CKB per on-chain **byte**, and v1 objects carry
post-quantum keys and a RISC-V binary (figures from the 2026-07-17 live run):

- contract code cell ≈ 3.0 KB → 3,127 CKB (locked permanently)
- profile cell ≈ 3.3 KB → ~3,410 CKB
- message cell ≈ 1.7 KB → ~1,880 CKB (reclaimed by the sender at the end)

Alice pays for the deployment plus her profile and message (~8,420 CKB
total); Bob pays for his profile and his response (~5,250 CKB). Message
capacity returns to Alice on reclaim; the contract and profile capacities
stay locked in their cells. The faucet dispenses 10,000 CKB per claim
(300,000 CKB/month/address), so one claim per address suffices.
