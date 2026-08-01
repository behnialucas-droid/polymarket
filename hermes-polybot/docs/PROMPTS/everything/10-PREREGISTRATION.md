# 10 — Preregistration: ≥30-day exploratory paper trial

## Purpose

Freeze the trial protocol BEFORE the first observation so outcomes cannot be tuned after the fact. Companion to `06-MONTH-TRIAL.md`; manifest and scenario templates in `APPENDIX-B-TRIAL-AND-SCENARIO-TEMPLATES.md`.

## Preconditions

- RUNBOOK-02/03/05/06 verified: migrations applied, one green cycle with all invariant SQL passing, exactly one scheduler owner, Telegram delivery confirmed.
- `RULES_AUTOUPDATE_ENABLED=false` in every environment that runs the cycle. It stays false for the entire window; flipping it mid-trial invalidates the trial.

## Frozen manifest (fill before start; immutable afterwards)

```text
trialId:                 ______________________
startDateUtc:            ____-__-__T00:00:00Z     # frozen; window is >= 30 days
endDateUtc:              ____-__-__T00:00:00Z
codeCommitSha:           ______________________   # git rev-parse HEAD at freeze
ruleSetVersion:          ______________________   # active RuleSet row version
costModelVersion:        cost-v1                  # seeded by migration 007
riskLimitVersion:        risk-v1                  # seeded by migration 007
cohortGeneration:        ______                   # RescanRun generation the cohort was built from
accountingModel:         signed v2 paper ledger (migrations 005/007/008)
rulesAutoupdate:         false (frozen)
analysisPlanHash:        ______________________   # sha256 of this file at freeze
```

Record the manifest per Appendix B section 1 and store it before `startDateUtc`. Any change after start is a new trial, not an amendment.

## Metrics — predeclared

Primary: cost-inclusive net PnL on the signed paper account (fees, spread, slippage, impact per cost-v1), compared against:

- (a) blind-copy benchmark — copy every eligible observed trade, same timestamps, same cost model, no scoring/admission;
- (b) skip counterfactual — copy nothing; PnL identically zero, same capital denominator.

Secondary: probability of loss, max drawdown, admission funnel yield (observed → scored → admitted → filled counts and ratios). Unresolved exposure is reported SEPARATELY at each cut — awaiting settlement is neither profit nor loss and is never folded into realized PnL.

## Uncertainty — predeclared method

Circular block bootstrap on daily PnL increments: block length ~3 days, fixed seed, 10000 resamples, percentile interval. Implementation: `runtime/src/lib/research/stats.ts` (`blockBootstrapTotal`, seeded by `mulberry32`; drawdown via `maxDrawdown`). The seed and block length are frozen in the manifest era; changing them post hoc is tuning.

Scenario comparisons (latency, cost, sizing variants) are restricted to the predeclared matrix in `APPENDIX-B-TRIAL-AND-SCENARIO-TEMPLATES.md` section 4. No new scenarios may be added after `startDateUtc`.

## Verify (at freeze)

```sh
cd hermes-polybot/runtime
git rev-parse HEAD                        # matches codeCommitSha
psql "$DATABASE_URL" -c 'SELECT "version" FROM "CostModelParams";'   # cost-v1
psql "$DATABASE_URL" -c 'SELECT "version" FROM "RiskLimit";'         # risk-v1
psql "$DATABASE_URL" -c 'SELECT MAX("generation") FROM "RescanRun" WHERE "status" = '"'"'complete'"'"';'
sha256sum docs/PROMPTS/everything/10-PREREGISTRATION.md              # analysisPlanHash
```

All values must equal the manifest. Mismatch → do not start; fix and re-freeze.

## Power caveat — predeclared conclusion rule

One month of daily observations is a small sample. If the bootstrap interval for the primary metric includes zero, or N is below the manifest's minimum sample size, the ONLY permitted conclusion is: "insufficient evidence". Not "promising", not "nearly significant". Negative point estimates are reported as-is.

## Standing statement

One month of paper observations is exploratory. This trial cannot prove profitability, safety, edge, or future live performance, and no such promise is made or implied. A negative or inconclusive result is a valid, publishable outcome of this protocol and must be reported with the same completeness as a positive one.

## Failure handling

- Any frozen field drifts mid-window (rule edit, cost/risk reseed, cohort rebuild, `RULES_AUTOUPDATE_ENABLED` flipped) — mark the trial invalid per `06-MONTH-TRIAL.md` stop rules; preserve all raw data; restart with a new manifest.
- Stop-condition breach (coverage, provenance, reconciliation, exposure) — stop paper copying, keep observing, report invalidation. Never delete inconvenient observations.
