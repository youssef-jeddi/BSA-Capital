# On-chain evidence

`data/` is gitignored (it holds seeds). To put verified transactions in the repo,
copy the run log here and commit it:

```bash
cp data/tx-log.jsonl docs/evidence/tx-log-$(date +%H%M).jsonl
```

Each line records: intent, account, transaction type, result code, tx hash, latency.
Explorer: `https://devnet.xrpl.org/transactions/<hash>`
