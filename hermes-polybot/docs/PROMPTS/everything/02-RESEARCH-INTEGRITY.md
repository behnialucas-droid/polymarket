# 02 — Research integrity: event time and no lookahead

Normative contract: `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md`. Do not restate competing formulas.

## Required implementation order

1. Inspect current migrations, adapter types, raw payloads, `ObservedTrade`, `MarketSnapshot`, and `DecisionJournal`.
2. Define additive schema for provider event identity, source/event/observed/ingest timestamps, payload digest, replay run, immutable decision feature snapshot, decision time, rule/cohort/profile/cost versions, and settlement observation.
3. Define migration state, transaction, lock, backup, rollback, backfill labeling, and compatibility path before applying migration.
4. Store one snapshot at or before decision time. Link each decision to exact snapshot ID. A missing usable snapshot creates structured rejection; no live refetch fallback.
5. Rework historical wallet profiling to use records available by cutoff. Current `fetchMarket()` is not historical truth.
6. Rework benchmarks to use decision snapshot ID. `MAX("id") FROM "MarketSnapshot"` is prohibited.
7. Preserve late/out-of-order events in replay quarantine; never advance watermark after partial failure.

## Timestamp policy

Use UTC. Enforce `event <= observed <= ingest`, `quoteCollected <= decision`, and declared quote staleness. Distinguish future, stale, missing, malformed, and provider-incomplete provenance. Record one cycle clock per batch.

## Cohort and rule provenance

Freeze wallet universe at named timestamp. Persist cohort selection version, rule version, score schema version, accounting model, cost model, and profile as-of cutoff. Test period cannot select current leaderboard winners or tune adaptive rules.

## Acceptance

- Every decision has exactly one immutable feature snapshot or explicit rejection.
- Source side, Hermes strategy action, and signed-paper effects are persisted separately.
- Query proves snapshot collection time is not after decision time.
- Benchmark cannot consume later resolution or price.
- Future snapshot test fails closed.
- Profile cutoff excludes future trades and current market state.
- Late-arrival/pagination/error replay tests preserve completeness evidence.

## Verification

```sh
git diff --check
cd runtime
npm test
npm run mirror 2>/dev/null || true
```

Database migration verification requires empty schema and representative schema. Without reachable Postgres: `BLOCKED`, never `PASS`.
