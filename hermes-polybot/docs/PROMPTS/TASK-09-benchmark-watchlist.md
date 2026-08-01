# TASK-09 — Watchlist losers are never counted as avoided

## Problem

`computeBenchmarks` in `src/lib/engine/paperTrading.ts`:

```ts
    if (h.decision === 'watchlist') { watchPnl += pnl; watchTrades++; if (won) missedWinners++; }
    if (h.decision === 'skip') { skipPnl += pnl; skipTrades++; if (won) missedWinners++; else avoidedLosers++; }
```

For `skip`, both outcomes are counted: a winner is a missed winner, a loser is an avoided loser.
For `watchlist`, only the winner branch exists. A watchlisted market that would have lost money
is credited to nobody.

The headline comparison the whole project exists to answer — *is bot filtering better than blind
copying?* — is therefore biased against the bot: its wins from declining to copy are
systematically under-counted.

There is a second, subtler problem in the same function: the counterfactual uses a flat `$10`
while real paper trades are sized `$5–$20` by confidence. That is defensible (blind copying has
no confidence signal to size on) but it is undocumented, so a reader assumes like-for-like.

## Decision

Count both outcomes for both non-copy decisions, and separate the two questions the numbers
answer. `missedWinners` / `avoidedLosers` become totals across all declined decisions, with a
per-decision breakdown so the watchlist tier can be judged on its own.

Document the flat-$10 choice in a comment. Do not change it — changing the counterfactual
sizing would silently invalidate every stored benchmark.

## File to change

`/home/nima/.../runtime/src/lib/engine/paperTrading.ts` — **MIRRORED**

## Edit 1 — extend the result type

BEFORE (must match exactly):
```ts
  watchlist: { trades: number; hypotheticalPnl: number };
  skipped: { trades: number; hypotheticalPnl: number };
  missedWinners: number; // watch/skip decisions that would have won
  avoidedLosers: number; // skip decisions that would have lost
}
```

AFTER:
```ts
  watchlist: { trades: number; hypotheticalPnl: number; missedWinners: number; avoidedLosers: number };
  skipped: { trades: number; hypotheticalPnl: number; missedWinners: number; avoidedLosers: number };
  /** Totals across every declined decision (watchlist + skip). */
  missedWinners: number;
  avoidedLosers: number;
}
```

## Edit 2 — count both outcomes for both tiers

BEFORE (must match exactly):
```ts
  let watchPnl = 0, watchTrades = 0, skipPnl = 0, skipTrades = 0;
  let missedWinners = 0, avoidedLosers = 0;
```

AFTER:
```ts
  let watchPnl = 0, watchTrades = 0, skipPnl = 0, skipTrades = 0;
  let watchMissed = 0, watchAvoided = 0, skipMissed = 0, skipAvoided = 0;
```

BEFORE (must match exactly):
```ts
    if (h.decision === 'watchlist') { watchPnl += pnl; watchTrades++; if (won) missedWinners++; }
    if (h.decision === 'skip') { skipPnl += pnl; skipTrades++; if (won) missedWinners++; else avoidedLosers++; }
```

AFTER:
```ts
    // Both tiers are symmetric: declining a winner is a miss, declining a loser is an avoid.
    // Previously the watchlist branch counted only misses, biasing the comparison against the bot.
    if (h.decision === 'watchlist') { watchPnl += pnl; watchTrades++; if (won) watchMissed++; else watchAvoided++; }
    if (h.decision === 'skip') { skipPnl += pnl; skipTrades++; if (won) skipMissed++; else skipAvoided++; }
```

## Edit 3 — return the breakdown

BEFORE (must match exactly):
```ts
    watchlist: { trades: watchTrades, hypotheticalPnl: Math.round(watchPnl * 100) / 100 },
    skipped: { trades: skipTrades, hypotheticalPnl: Math.round(skipPnl * 100) / 100 },
    missedWinners, avoidedLosers,
```

AFTER:
```ts
    watchlist: { trades: watchTrades, hypotheticalPnl: Math.round(watchPnl * 100) / 100, missedWinners: watchMissed, avoidedLosers: watchAvoided },
    skipped: { trades: skipTrades, hypotheticalPnl: Math.round(skipPnl * 100) / 100, missedWinners: skipMissed, avoidedLosers: skipAvoided },
    missedWinners: watchMissed + skipMissed,
    avoidedLosers: watchAvoided + skipAvoided,
```

## Edit 4 — document the counterfactual sizing

Find this comment:
```ts
  // hypothetical: what every observed trade would have returned at $10 flat if its market resolved
```

Replace with:
```ts
  // Hypothetical: what every observed trade would have returned at a FLAT $10 if its market
  // resolved. Deliberately flat, not confidence-sized: blind copying has no confidence signal,
  // so sizing it by the bot's own confidence would flatter the baseline. This means botFiltered
  // (sized $5-$20) and blindCopy ($10) are NOT dollar-comparable — compare win rate and
  // per-trade average, not raw PnL totals.
```

## Downstream check

`computeBenchmarks` is consumed by the dashboard and the reports. After editing, grep for
consumers and confirm none break on the shape change:

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot
grep -rn --include='*.ts' --include='*.tsx' "computeBenchmarks\|missedWinners\|avoidedLosers" runtime dashboard | grep -v node_modules
```

Existing readers of the top-level `missedWinners` / `avoidedLosers` keep working — those keys
still exist. If a consumer destructures `watchlist` or `skipped` positionally, fix it; if it
reads by key, leave it alone.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm test
diff src/lib/engine/paperTrading.ts ../dashboard/src/lib/engine/paperTrading.ts && echo "MIRROR OK"
npx tsc --noEmit -p ../dashboard 2>&1 | head -5
```

Expected: `# fail 0`, `MIRROR OK`, and no TypeScript output from the dashboard check.
