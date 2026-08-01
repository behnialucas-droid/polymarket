# 06 — One-month exploratory paper trial

Normative contract: `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md`; manifest and scenarios: `APPENDIX-B-TRIAL-AND-SCENARIO-TEMPLATES.md`.

## Purpose

Run preregistered observational paper research. It cannot prove future live profitability, safety, or edge.

## Before start

Store immutable manifest containing trial ID, UTC period, frozen wallet cohort and selection version, 24-hour horizon, rule/score/accounting/cost versions, capital and exposure caps, bot/blind/watch/skip arms, latency/bid-ask/fee/slippage/impact/partial-fill/stale assumptions, primary net return on capital at risk, secondary metrics, sample size, missingness limits, stop conditions, owner, and analysis-plan hash.

Freeze cohort, rules, score, cost model, sizing, metrics and report definitions for test period. Train/validation may compare predeclared scenarios; test may not tune them.

## Required observations

Keep every observed event: copied, watch, skip, rejected, unsupported SELL, stale/missing snapshot, unresolved, invalidated, API error, late event, and portfolio-cap rejection. Denominators include eligible and ineligible counts. Settlement occurs only with authoritative final outcome.

Daily reconciliation must cover cash, open quantity, mark source, realized/unrealized net PnL, fees, explicit costs, exposure, turnover and drawdown. Use block bootstrap or time-series interval. Report confidence interval, probability of loss, raw counts, coverage and sample warning.

## Daily report

```text
trial / period / cohort / rule / accounting / cost versions
observed / eligible / copied / watch / skipped / rejected / unresolved / invalidated
net simulated PnL / return on capital at risk / average and max exposure / turnover
fees / spread / slippage / impact / max drawdown / concentration
bot vs blind vs watch vs skip, same timestamps and costs
snapshot coverage / stale rate / API error rate / provenance completeness
interval / probability of loss / denominator / sample warning
reconciliation status / incidents / exact next action
```

## Stop and invalidate

Stop paper copying and mark trial invalid if decision-time coverage, settlement provenance, reconciliation, stale quote, API completeness, missing-data, unauthorized endpoint, or exposure limits breach preregistered thresholds. Preserve raw data; never delete inconvenient observations.

## Acceptance

No `PASS` until manifest exists, first-day reconciliation is green, dashboard exposes all denominators and costs, frozen versions match decisions, and blocked database/network checks are separately reported.
