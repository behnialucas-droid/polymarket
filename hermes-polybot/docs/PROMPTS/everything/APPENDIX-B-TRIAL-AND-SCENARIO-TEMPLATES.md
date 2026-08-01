# Appendix B — trial and scenario templates

## 1. Trial manifest

Store versioned JSON before collecting evaluation observations:

```json
{
  "trialId": "",
  "accountingModel": "counterfactualIsolated",
  "periodUtc": {"start": "", "end": ""},
  "cohort": {"id": "", "frozenAt": "", "selectionRuleVersion": ""},
  "rules": {"version": "", "scoreSchemaVersion": "", "frozen": true},
  "horizon": {"maxHours": 24},
  "costModel": {"version": "", "fee": "", "slippage": "", "impact": "", "latencyMs": "", "partialFill": "", "staleQuoteMaxAgeSec": 0},
  "capital": {"allocated": 0, "maxPosition": 0, "maxPortfolioExposure": 0, "maxMarketExposure": 0, "maxWalletExposure": 0, "maxTurnover": 0},
  "arms": ["bot", "blind", "watch", "skip"],
  "primaryMetric": "netReturnOnCapitalAtRisk",
  "secondaryMetrics": ["hitRate", "averageTrade", "maxDrawdown", "turnover", "exposure", "capacity", "calibration", "probabilityOfLoss"],
  "minimumSampleSize": 0,
  "missingDataThreshold": 0,
  "stopConditions": [],
  "analysisPlanHash": "",
  "owner": ""
}
```

No rule, cohort, cost, sizing, or metric change after test start. Changes create a new trial or invalidate current trial.

## 2. Daily report

```text
trial / period / accounting model / rule version / cohort version / cost version
observed / eligible / copied / watch / skipped / rejected / unresolved / invalidated
net simulated PnL / return on capital at risk / average exposure / max exposure
turnover / max drawdown / concentration / open unresolved exposure
fees / spread cost / slippage / impact / stale quote rate / API failure rate
bot vs blind vs watch vs skip, same timestamps and cost assumptions
confidence interval / probability of loss / raw denominator / sample warning
reconciliation status / decision-time coverage / provenance completeness
```

## 3. Scenario proposal

Every candidate change records:

```text
hypothesis
parameter/rule version
training period
validation period
untouched evaluation period
cohort and data snapshot
cost and execution assumptions
primary/secondary metrics
rejection and missingness policy
stopping rule
comparison baseline
analysis owner
```

Scenario result language: `better/worse under stated historical-paper assumptions`. Never `profitable`, `guaranteed`, or `best` without uncertainty and scope.

## 4. Predeclared scenario matrix

Run alternatives only on training/validation. Freeze selected configuration before future test.

### Universe selection

- rank-only leaderboard cohort;
- minimum resolved-history cohort;
- short-term-share-qualified cohort;
- short-term subject-qualified cohort;
- data-quality and provenance-complete cohort.

Report cohort turnover, coverage, concentration, rejected wallets, and selection stability.

### Scoring

- current weighted score;
- score with explicit missing-data/provenance penalty;
- calibrated probability score trained only on prior window;
- score with separate horizon gate and no hidden horizon double-count;
- score ablation removing one component at a time.

No automatic parameter ratchet during test. Record raw score distributions and calibration by decile.

### Execution realism

- midpoint diagnostic only;
- executable bid/ask;
- bid/ask plus fixed slippage stress;
- bid/ask plus liquidity-dependent impact;
- latency buckets and stale quote rejection;
- partial-fill fractions.

All arms use same timestamps, quote availability, cost model and unresolved treatment.

### Portfolio construction

- fixed equal notional;
- confidence-scaled notional with hard caps;
- liquidity-scaled notional with hard caps;
- equal-risk paper allocation with concentration limits.

Compare exposure-time, turnover, drawdown, capacity proxy, and missing decisions. Larger notional is not evidence of better strategy.

### Decision policy

- copy threshold only;
- copy/watch/skip thresholds;
- uncertainty and provenance completeness gate;
- portfolio-cap admission gate;
- stale/unresolved exposure gate.

Every rejected event remains in denominator.

### Robustness grid

Stress predeclared values for:

- quote age and decision latency;
- fee;
- spread crossing;
- slippage and impact;
- fill fraction;
- maximum horizon;
- missing API pages and late arrivals;
- portfolio exposure and concentration caps.

Use block bootstrap or another time-series method. Report confidence interval, probability of loss, worst block, and sensitivity. Do not tune stress grid after seeing test results.

## 5. Trial invalidation

Mark trial invalid and stop paper copying when decision-time coverage, provenance, reconciliation, settlement authority, missing-data, stale quote, API completeness, or unauthorized endpoint checks breach preregistered limits. Preserve all raw data and reports.

## 6. Final report

Final report must contain raw counts, denominators, period, frozen versions, accounting model, costs, exposure, turnover, drawdown, unresolved treatment, benchmark alignment, uncertainty, probability of loss, limitations, blocked checks, and exact next experiment. It must not infer future live performance.
