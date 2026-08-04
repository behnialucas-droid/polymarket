# 11 — Short-Term Wallet Scoring Epochs

The copy-wallet universe is versioned by **scoring epochs** (migration `012`).
Legacy scores were built from mostly long-term history, so the copy gate trusted
wallets whose signals the 24h horizon gate then rejected. An epoch rebuild fixes
the source, not the gate.

## Contract

- `ScoringEpoch`: one row per rebuild; at most ONE row has `active = TRUE`
  (partial unique index). Activation is audited in `ScoringEpochAudit`.
- `WalletProfile.scoringEpoch` stamps which epoch produced the wallet's
  short-term metrics. Legacy columns (`globalScore`, …) are kept for audit and
  never gate a copy while an epoch is active.
- Pipeline gate (`scoreNewTrades`): when an active epoch exists, a wallet is a
  copy source ONLY if `scoringEpoch` matches the active epoch AND
  `shortTermCopyScore` is non-null AND `shortTermRank` is non-null (top-N).
  Anything else journals a durable skip:
  `wallet not scored and ranked in active scoring epoch <id>`.
- No active epoch (or pre-012 database): legacy gate applies unchanged.

## Scoring formula (`engine/shortTermWalletScoring.ts`)

A trade counts only if ALL hold at scoring time `T`:

1. commitment `holdHours(entry, endDateIso) ∈ (0, maxHours]` (default 24h);
2. market resolution is **confirmed** (`resolved === true` with a concrete
   `resolvedOutcome`);
3. `endDateIso <= T` — **no lookahead**: a market ending after `T` cannot have
   had a resolution at `T`.

Per counted trade: `recency = exp(-ln2 · ageDays / halfLife)` (half-life default
14d), `weight = recency · stakeUsd`.

- `winRate` = weight-fraction of trades with `pnlPerDollar > 0`
- `pnlPerDollar` = weighted mean realized pnl per $1 staked
- `pnlScore` = clamp((pnlPerDollar + 0.2) / 0.6)  — same band as legacy roiScore
- `copyScore = clamp(0.45·winRate + 0.35·pnlScore + 0.20·meanRecency)`

**Fail-closed minimum sample:** below `SHORT_TERM_MIN_TRADES` (default 10)
confirmed short-term resolutions, `copyScore` is `NULL` — never a default pass.
A wallet with only long-term history can NEVER qualify.

## Universe rebuild

```sh
# 1. Score a new candidate epoch (inactive; nothing changes for the pipeline)
node --experimental-strip-types scripts/rescore-wallets-shortterm.ts

# 2. Review the diff, then activate explicitly
EPOCH_ID=<id> node --experimental-strip-types scripts/activate-scoring-epoch.ts          # dry run
EPOCH_ID=<id> EPOCH_CONFIRM=yes node --experimental-strip-types scripts/activate-scoring-epoch.ts
```

Env knobs: `SHORT_TERM_MAX_HOURS` (24), `SHORT_TERM_MIN_TRADES` (10),
`SHORT_TERM_RECENCY_HALF_LIFE_DAYS` (14), `WALLET_UNIVERSE_SIZE` (500),
`WALLET_RESCORE_LIMIT` (1000).

Top-N selection is deterministic: score descending, ties broken by ascending
address. If fewer than `WALLET_UNIVERSE_SIZE` wallets qualify, the shortfall is
reported and the universe stays smaller — it is never padded with unproven
wallets. The universe grows as more short-term resolutions accumulate.

## Invariants (tested in `tests/shortTermWalletScoring.test.ts`)

- 25h commitment excluded, 23h included.
- Unresolved or future-ending markets never count (no lookahead).
- Sub-minimum sample ⇒ `copyScore = NULL` (fail-closed).
- Recency decay is monotonic; losses score below wins.
- Top-N is deterministic and hard-truncated.

## Signal freshness and decision-time quotes (fix commit 0b32f21)

- **Observation follows the active epoch**: `monitorTrades` watches the ranked
  epoch universe (rank order) when an epoch is active; legacy status selection
  applies only when none is active.
- **Copy signals expire**: `evaluateSignalFreshness` (default `MAX_SIGNAL_AGE_MIN`
  = 20) gates every decision. Missing/unparsable/future timestamps fail closed.
  A stale signal journals a durable skip and is NEVER re-quoted.
- **Decision-time snapshot refresh** applies to FRESH signals only: if the
  persisted snapshot is missing/older than 60s, the pipeline fetches and
  persists the decision-time quote — that quote IS the decision evidence.
  Old signals never trigger a refetch (no lookahead).
- **Horizon contract**: rules can never set `maxTimeToResolutionHours` above 24.
- **Activation guards**: refuses demo/live ranked-wallet mode mismatch (override
  `EPOCH_ALLOW_MODE_MISMATCH=yes`), warns when the universe is thin (<25) or
  P90 score sits below `minWalletGlobalScore`.
