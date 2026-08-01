# 01 — Rules, horizon, and decision clock

Read `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md` before editing runtime.

## Contract

- One cycle owns one immutable `cycleNowMs`; all decisions in cycle use it.
- Persist `ruleVersion`, `scoreSchemaVersion`, `accountingModel`, `costModelVersion`, and cohort ID with every decision.
- Absolute `endDateIso` is horizon source. Relative TTR is adapter-time fallback only.
- Eligible horizon is `0 < hoursToResolution <= 24`; expired, missing, stale, malformed, or contradictory horizon fails closed.
- Short-term wallet share is a soft wallet gate: insufficient share may remain `watch`, never `track/copy`.
- Invalid persisted numeric rules normalize to safe defaults. Zero/negative/non-finite values cannot disable safety gates.
- Every skip, watch, rejection, stale quote, missing snapshot, unsupported side, and portfolio cap is retained with structured reason.

## Allowed work

Inspect `runtime/src/lib/engine/rules.ts`, `horizon.ts`, `tradeScoring.ts`, `walletScoring.ts`, mirrored dashboard files, and tests before editing. Keep runtime authoritative. Add focused tests for invalid persisted rules, relative-only fallback parity, boundary horizons, and deterministic clock. Do not tune thresholds from test outcomes.

## Acceptance

- Clock and versions are recorded per decision.
- No decision uses future horizon or current-time fallback accidentally.
- Rule JSON cannot create unsafe gate behavior.
- Rejection reasons preserve denominator for later trial analysis.
- Runtime and dashboard mirrors match.

## Verification

```sh
git diff --check
cd runtime
npm test
npm run mirror 2>/dev/null || true
```

No profitability conclusion allowed. Database checks require real Postgres; otherwise `BLOCKED`.
