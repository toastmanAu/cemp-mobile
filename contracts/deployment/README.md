# Deployment records

Every CEMP contract deployment gets a record file here:

```json
{
  "network": "ckb_testnet",
  "contract": "cemp-message-type",
  "version": "0.1.0",
  "deployTxHash": "0x…",
  "outPointIndex": 0,
  "codeHash": "0x…",
  "hashType": "type|data1",
  "deployedAt": "YYYY-MM-DD",
  "sourceCommit": "…",
  "notes": "…"
}
```

Nothing is deployed yet. The ML-DSA-65 lock CEMP relies on is deployed and
documented externally — see `docs/grounding/reference-projects.md` §3 for its
testnet identifiers (and why the v1 deployment is deprecated).
