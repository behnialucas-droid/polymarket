# Appendix A — immutable data and accounting contract

This document is normative. Cards `02`, `03`, `05`, `06`, and `09` must reference this contract instead of inventing divergent formulas.

## 1. Scope and accounting model

Hermes remains paper-only. Initial accounting model is:

```text
accountingModel = counterfactualIsolated
```

Each approved wallet event creates an independent hypothetical paper position. This is not wallet realized PnL and cannot be presented as reconstruction of wallet inventory.

A future `fillReplay` model may reconstruct wallet inventory using provider-native fills, FIFO or average-cost policy, and explicit short/close semantics. It requires a new version, migration, tests, and trial registration. It must not be introduced by silently negating current PnL.

## 2. Immutable records and provenance

Every raw activity record stores, when available:

- `source` and `sourceSchemaVersion`;
- provider-native activity/fill ID;
- transaction hash, order ID, asset/token ID, condition ID;
- wallet, market, outcome, side, price, shares/notional;
- `eventTimestamp` from provider;
- `observedAt` when Hermes received it;
- `ingestedAt`, replay run ID, cursor/page, payload digest;
- raw payload unchanged.

Provider ID is the primary idempotency key: `(source, providerEventId)`. Full canonical-payload hash is fallback only and must be marked collision-prone. It cannot silently discard a second fill with the same second-level timestamp.

Corrections append a new record referencing the old record, correction reason, actor/run, and timestamp. Historical evidence is never overwritten.

## 3. Event-time invariant

Use UTC timestamps. Let:

- `te` = provider event time;
- `to` = Hermes observed time;
- `tq` = quote/snapshot collection time;
- `td` = decision time;
- `ti` = ingest time.

Require, when fields exist:

```text
te <= to <= ti
te <= td
 tq <= td
0 <= td - tq <= maxQuoteAge
```

A source with no event time is `provenance_incomplete`, not silently assigned current time. Future, stale, malformed, and contradictory timestamps get structured rejection reasons.

A decision references exactly one immutable decision-time feature snapshot. Snapshot `collectedAt <= decisionAt`; its market price, bid/ask, spread, liquidity, horizon, and unresolved state are the only features available to that decision. A future snapshot cannot repair a missing decision snapshot.

Historical profile features use only data available by the declared as-of cutoff. Present-day `fetchMarket()` is not historical truth for an old wallet event.

Final settlement is separate from feature snapshots. It requires authoritative finalized outcome, source, resolution event, and finalized timestamp. `closed` alone is not settlement.

## 4. Decision and benchmark joins

`DecisionJournal` must retain:

- observed event ID;
- decision snapshot ID;
- decision time and cycle clock;
- wallet profile version;
- frozen cohort ID;
- ruleset and score schema versions;
- cost model version;
- feature digest and rejection reasons.

Benchmark, blind, watch, and skip arms join the exact decision snapshot ID. This is prohibited:

```sql
MAX("id") FROM "MarketSnapshot"
```

A benchmark must not read later price, resolution, or outcome fields. Outcome can be evaluated only after authoritative settlement and remains absent before then.

## 5. Position and side policy

Signed v2 `counterfactualIsolated` policy:

- source `BUY` creates a candidate Hermes `OPEN_LONG` or `INCREASE_LONG` action;
- source `SELL` creates a candidate Hermes `OPEN_SHORT` or `INCREASE_SHORT` action;
- source side is evidence, never a command to mutate existing Hermes inventory;
- opening/increase actions do not implicitly net, close, or reverse opposite Hermes lots;
- `REDUCE_LONG` and `REDUCE_SHORT` close only their named Hermes lots FIFO;
- `FLATTEN` requires explicit directional orchestration when both long and short exposure exists;
- source-wallet shares/notional never size a Hermes action directly; independent risk sizing does;
- no side defaults to `BUY`.

Legacy long-only rows retain their historical `SELL_NO_POSITION` policy and are not reinterpreted. A future source-wallet fill replay may reconstruct source inventory, but it remains separate from Hermes signed paper inventory.

## 6. Cost-inclusive signed-paper equations

For `q > 0`, price `p ∈ (0,1)`, entry fee `fe`, exit fee `fx`, and short buffer `b`:

```text
long entry collateral  = q * p + fe
short entry collateral = q * (1 - p) + fe + b
```

Short-sale credit remains locked collateral, never available cash.

```text
long mark PnL  = q * (markPrice - entryPrice) - allocatedEntryCosts
short mark PnL = q * (entryPrice - markPrice) - allocatedEntryCosts

long realized PnL  = q * exitPrice - allocatedLongCostBasis - fx
short realized PnL = q * (1 - exitPrice) - allocatedShortCostBasis - fx
```

For authoritative final settlement `s ∈ {0,1}`:

```text
long settlement PnL  = q * (s - entryPrice) - entryCosts - exitFees
short settlement PnL = q * (entryPrice - s) - entryCosts - exitFees
```

If executable quote, quote freshness, fee, collateral, or cost-model input is missing, reject or mark `cost_incomplete`; do not use fabricated `0.5` or midpoint as executable fill.

Unknown, disputed, invalid, cancelled, or unresolved outcome produces `awaiting_settlement` or `invalidated`; never a default loss. Store requested/filled notional, quantity, directional lots, entry/exit quotes, fee, spread cost, slippage, impact, latency, fill fraction, cost-model version, collateral, price provenance, and PnL status.

## 7. Portfolio risk controls

Admission must enforce, at minimum:

```text
openExposure + newFilledNotional <= maxPortfolioExposure
positionNotional <= maxPositionNotional
marketExposure <= maxMarketExposure
walletExposure <= maxWalletExposure
categoryExposure <= maxCategoryExposure
dailyTurnover + newFilledNotional <= maxDailyTurnover
```

Also reject stale quote, excessive spread, unresolved exposure cap, duplicate decision, missing snapshot, missing cost inputs, invalid price, and incomplete provenance. Every rejection is retained with reason and timestamp.

Sizing is paper research, not an optimization guarantee. Candidate policies for predeclared validation scenarios include fixed notional, capped equal-risk, confidence-scaled capped notional, and liquidity-scaled notional. No policy may exceed portfolio constraints.

## 8. Equity reconciliation

For each reporting timestamp:

```text
equity = cash + sum(open quantity * mark price)
```

Across a closed interval:

```text
equityEnd - equityStart
  = realizedNetPnl + unrealizedMarkChange
  - fees - explicit costs
  + deposits - withdrawals
```

Use decimal-safe numeric storage and declared rounding tolerance. Reconciliation failure invalidates the affected report/trial; it is not hidden by rounding.

## 9. Required tests and audit queries

Before `PASS`, tests must prove:

- provider ID dedup preserves same-second distinct fills;
- long/short win/loss includes costs and directional collateral;
- source SELL opens independent short; explicit reductions close only named direction;
- no implicit netting, negative lots, or double collateral release;
- missing/stale/future snapshots reject;
- benchmark cannot select latest snapshot;
- profile cutoff excludes future market state;
- unresolved/invalid settlement does not become loss;
- partial fill and cost calculations are deterministic;
- portfolio caps create structured rejection;
- equity reconciliation passes and fails loudly when tampered.

Database verification requires reachable Postgres, empty-schema migration, representative-schema migration, indexes, constraints, and rollback evidence. Without database access, status is `BLOCKED`.
