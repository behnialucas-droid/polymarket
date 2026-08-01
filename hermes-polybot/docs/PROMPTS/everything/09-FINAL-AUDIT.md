# 09 — Final audit

## Evidence-only closeout

Run from canonical repository. Preserve dirty work; do not commit/push/deploy.

```sh
git rev-parse --show-toplevel
git status --short
git diff --check
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm test
npm run mirror 2>/dev/null || true
npx tsc --noEmit --strict --module nodenext --target es2022 --allowImportingTsExtensions --skipLibCheck src/lib/engine/*.ts src/lib/classify.ts scripts/pipeline.ts
```

## Static safety and architecture scans

```sh
grep -RIn --exclude-dir=node_modules --exclude-dir=.next -E 'signTransaction|signTypedData|privateKey|PRIVATE_KEY|MNEMONIC|SEED_PHRASE|ethers|viem|web3|placeOrder|createOrder' runtime dashboard || true
grep -RIn --exclude-dir=node_modules --exclude-dir=.next 'timeToResolutionHours ?? Infinity' runtime dashboard || true
grep -RIn --exclude-dir=node_modules --exclude-dir=.next 'MAX("id") FROM "MarketSnapshot"' runtime dashboard || true
grep -RIn --exclude-dir=node_modules --exclude-dir=.next 'resolved.*closed|closed.*resolved' runtime dashboard || true
```

## Evidence matrix

For each invariant, record:

```text
invariant / source file or schema / test or SQL query / actual output
status PASS|FAIL|BLOCKED / affected count / limitation / next card
```

Minimum invariants:

- paper-only boundary and no signing/order path;
- provider identity and replay completeness;
- decision snapshot as-of ordering;
- profile cutoff and benchmark snapshot identity;
- rule/cohort/accounting/cost version freeze;
- BUY cost-inclusive PnL;
- SELL explicit rejection or tested fill-replay;
- unresolved settlement not default loss;
- portfolio caps and structured rejection;
- cash/equity reconciliation;
- dashboard error and disclosure behavior;
- migration/lock/retry evidence;
- trial denominator, missingness and uncertainty.

## Required conclusion

State separately:

- what offline tests prove;
- what static inspection proves;
- what real database/network checks prove;
- what is blocked and exact error;
- which paper decisions are invalidated by future snapshots, missing provenance, unsupported side, or reconciliation failure;
- what remains exploratory for one-month trial;
- exact next card.

Never state `profitable`, `safe for real trading`, `best wallet`, or `guaranteed edge`. Acceptable conclusion is limited to evidence quality under named historical paper assumptions and uncertainty.
