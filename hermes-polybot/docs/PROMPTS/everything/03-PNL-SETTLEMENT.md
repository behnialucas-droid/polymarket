# 03 — Position, cost, and settlement model

Normative contract: `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md`.

## Approved v2 signed-paper model

Hermes remains paper-only. Source wallet events are immutable evidence; they never imply ownership of Hermes inventory.

- Qualified source `BUY` creates a candidate Hermes `OPEN_LONG` or `INCREASE_LONG` action.
- Qualified source `SELL` creates a candidate Hermes `OPEN_SHORT` or `INCREASE_SHORT` action.
- `OPEN_*` and `INCREASE_*` never implicitly close opposite Hermes inventory.
- `REDUCE_LONG`, `REDUCE_SHORT`, and a future explicit netting policy are the only ways to consume lots.
- A directionless `FLATTEN` must be orchestrated as explicit directional reductions; it must not guess a side.
- Source quantity informs signal quality and risk eligibility only. Hermes sizing follows its own versioned risk policy.

Legacy `PaperTrade` and long-only `PaperPosition` rows are quarantined historical evidence. Do not reinterpret legacy PnL as signed-ledger results.

## Binary-outcome economics

For `q > 0`, entry price `p ∈ (0,1)`, entry fee `fe`, exit fee `fx`, and short-only collateral buffer `b`:

```text
long entry collateral  = q * p + fe
short entry collateral = q * (1 - p) + fe + b
```

Short-sale credit remains locked collateral; it is never free buying power.

```text
long mark PnL  = q * (markPrice - entryPrice) - allocatedEntryCosts
short mark PnL = q * (entryPrice - markPrice) - allocatedEntryCosts

long realized PnL  = q * exitPrice - allocatedLongCostBasis - fx
short realized PnL = q * (1 - exitPrice) - allocatedShortCostBasis - fx
```

At authoritative final settlement `s ∈ {0,1}`:

```text
long settlement PnL  = q * (s - entryPrice) - entryCosts - exitFees
short settlement PnL = q * (entryPrice - s) - entryCosts - exitFees
```

Persistent money, shares, costs, and collateral use decimal-safe `NUMERIC` or fixed-point values. IEEE floating-point is permitted only inside pure test helpers with declared tolerance.

## Position lifecycle

```text
requested -> rejected | filled -> open -> awaiting_settlement -> resolved
                                      \-> invalidated
```

- `rejected`: snapshot, quote, cost, identity, exposure, collateral, or provenance check failed.
- `filled`: simulated executable fill and full cost inputs are persisted.
- `awaiting_settlement`: market closed but final authoritative result absent.
- `resolved`: final result has authority, identifier, and timestamp evidence.
- `invalidated`: disputed, cancelled, corrupted, or reconciliation-failed result.

`closed` is not final settlement. Unknown outcome never becomes a default loss.

## Execution and risk evidence

Store exact bid/ask, quote time, decision time, latency, spread crossing, slippage, impact, fill fraction, fees, requested/filled notional, cost-model version, and quote provenance. Missing executable inputs reject or become `cost_incomplete`; fabricated midpoint or `0.5` never becomes a fill.

Admission must enforce available collateral, gross and net exposure, per-instrument/wallet/category caps, daily turnover, concurrent-position cap, duplicate idempotency, quote age, horizon, spread, and liquidity.

## Required tests

- sell-first short; independent simultaneous long and short;
- directional partial/full reduction, FIFO allocation, no implicit reversal;
- long/short collateral conservation and locked short credit;
- long/short realized, mark, and settlement PnL with fees;
- stale/future/missing quote and invalid price rejection;
- unresolved, disputed, cancelled, and invalid settlement;
- idempotency, no double settlement, projection rebuild, and tamper detection.

## Acceptance

- No source SELL silently closes a Hermes long.
- No source BUY silently covers a Hermes short.
- Every PnL output declares action, accounting model, cost version, exposure, collateral, and settlement status.
- Realized, unrealized, collateral, cash, and source-wallet evidence stay distinct.
- No profitability claim precedes a preregistered, cost-inclusive paper trial.
