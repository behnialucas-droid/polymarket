# 05 — Dashboard and deployment boundary

Normative data and cost contract: `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md`.

## Topology

- Runtime worker owns ingestion, decisions, paper ledger, settlement and notifications.
- Dashboard is read-only presentation over Postgres/API.
- Vercel/browser endpoints do not run long-lived cycle, own lock, mutate rules, or substitute scheduler.
- Select exactly one production scheduler/worker owner. Document owner, lock, retry, logs, health and rollback.
- No dashboard control authorizes real trade, signing, wallet credential, or public mutation endpoint.

## Required dashboard disclosure

Every simulation/performance view shows:

- period UTC; cohort, rule, score, accounting and cost-model versions;
- raw counts/denominator; decision-time snapshot coverage; stale/missing/provenance failures;
- requested/filled notional, capital at risk, open exposure, concentration, turnover, drawdown;
- bid/ask, fees, slippage, impact, latency, partial-fill and unresolved/invalidated treatment;
- benchmark timestamp/cost alignment; confidence interval, probability of loss and sample warning;
- explicit `paper-only exploratory simulation` label.

Do not label pages `profitable`, `safe`, `edge`, `guaranteed`, or `live trading`. Empty/error query states render errors, not successful zero data.

## Acceptance

- Runtime and dashboard responsibilities are separate.
- Browser cannot trigger uncontrolled cycle.
- Metrics expose accounting model and data-quality limitations.
- Responsive UI retains disclosure and error state.

## Verification

```sh
git diff --check
cd dashboard
npm run build
```

For UI changes, start preview and verify rendered disclosure, error and narrow layout. Production deployment needs explicit operator approval.
