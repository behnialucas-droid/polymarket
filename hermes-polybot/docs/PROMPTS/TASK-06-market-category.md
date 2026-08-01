# TASK-06 — Category comes from a per-day-unique slug, so category edge is dead

## Problem

`src/lib/adapters/polymarket.ts`:

```ts
        marketCategory: t.eventSlug ?? t.category,
```

`eventSlug` looks like `bitcoin-up-or-down-july-30` or `nfl-buf-kc-2026-01-11` — a new unique
string every day. Downstream:

- `walletScoring.ts` builds `categoryStrengths` keyed by that slug, producing dozens of
  single-observation buckets.
- `tradeScoring.ts` looks up `wallet.categoryStrengths[trade.marketCategory]`, misses every
  time, and falls back to the neutral `0.5`.
- `thesisScore`'s `+0.3` bonus for `trade.marketCategory === wallet.bestCategory` almost never
  fires.

So "category edge" — a documented scoring dimension — is inert. Confirm on live data if you
have `DATABASE_URL`:

```bash
psql "$DATABASE_URL" -c 'SELECT "marketCategory", count(*) FROM "ObservedTrade" GROUP BY 1 ORDER BY 2 DESC LIMIT 15;'
```

Expect a long tail of count-1 rows.

## Decision

Derive a **stable coarse category** from the slug instead of using the slug raw. Keep the raw
slug too — it is still useful for subject matching — but score on the coarse key.

Do not invent a taxonomy from nothing: derive it from the slug's leading tokens, with an
explicit keyword map for the cases that matter.

## Files to change

1. **New file** `/home/nima/.../runtime/src/lib/engine/category.ts` — **MIRRORED**
2. `/home/nima/.../runtime/src/lib/adapters/types.ts` — **MIRRORED**
3. `/home/nima/.../runtime/src/lib/adapters/polymarket.ts` — **MIRRORED**
4. **New file** `/home/nima/.../runtime/tests/category.test.ts`

## Edit 1 — create category.ts

```ts
/**
 * Coarse, stable market categories.
 *
 * Polymarket's `eventSlug` is unique per event ("bitcoin-up-or-down-july-30"), so using it
 * as a category key produces one bucket per market and makes category edge unmeasurable.
 * This maps a slug/question to a small fixed set of keys that repeat across days.
 *
 * Pure: no clock, no I/O. Same input -> same output.
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(btc|bitcoin)\b/i, 'crypto-btc'],
  [/\b(eth|ethereum)\b/i, 'crypto-eth'],
  [/\b(sol|solana|xrp|doge|ada|bnb)\b/i, 'crypto-alt'],
  [/\b(nfl|nba|mlb|nhl|ufc|soccer|premier-league|laliga|tennis|f1)\b/i, 'sports'],
  [/\b(election|senate|president|congress|governor|parliament|vote)\b/i, 'politics'],
  [/\b(fed|cpi|inflation|gdp|rate-cut|unemployment|jobs-report)\b/i, 'macro'],
  [/\b(oscar|grammy|emmy|box-office|rotten-tomatoes)\b/i, 'entertainment'],
  [/\b(gpt|openai|anthropic|llm|ai-model)\b/i, 'ai'],
  [/\b(weather|hurricane|temperature)\b/i, 'weather'],
];

/**
 * @param slug     raw eventSlug, may be undefined
 * @param question market question text, may be undefined
 * @param declared the API's own `category` field, if present — trusted over slug guessing
 */
export function coarseCategory(slug?: string, question?: string, declared?: string): string {
  if (declared && declared.trim() && declared.length < 40) return declared.trim().toLowerCase();
  const hay = `${slug ?? ''} ${question ?? ''}`;
  for (const [re, key] of RULES) if (re.test(hay)) return key;
  // Fall back to the slug's first two tokens: "us-open-mens-final-2026" -> "us-open".
  // Still coarser than the full slug, and stable across recurring events.
  const tokens = (slug ?? '').split('-').filter(Boolean);
  if (tokens.length >= 2) return `${tokens[0]}-${tokens[1]}`.toLowerCase();
  if (tokens.length === 1) return tokens[0].toLowerCase();
  return 'unknown';
}
```

## Edit 2 — types.ts, keep the raw slug on the trade

BEFORE (must match exactly):
```ts
  marketQuestion?: string;
  marketCategory?: string;
  outcome?: string;
```

AFTER:
```ts
  marketQuestion?: string;
  /** Coarse, stable category used for scoring. See engine/category.ts. */
  marketCategory?: string;
  /** Raw per-event slug, kept for subject matching and debugging. Never used as a score key. */
  eventSlug?: string;
  outcome?: string;
```

## Edit 3 — polymarket.ts, map through coarseCategory

Add the import near the top:
```ts
import { coarseCategory } from '../engine/category.ts';
```

BEFORE (must match exactly):
```ts
        marketCategory: t.eventSlug ?? t.category,
```

AFTER:
```ts
        marketCategory: coarseCategory(t.eventSlug, t.title ?? t.question, t.category),
        eventSlug: t.eventSlug,
```

## Edit 4 — tests/category.test.ts

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coarseCategory } from '../src/lib/engine/category.ts';

test('recurring crypto events collapse to one stable key', () => {
  assert.equal(coarseCategory('bitcoin-up-or-down-july-30'), 'crypto-btc');
  assert.equal(coarseCategory('bitcoin-up-or-down-july-31'), 'crypto-btc');
  assert.equal(coarseCategory('eth-price-above-4000-today'), 'crypto-eth');
});

test('declared API category wins over slug guessing', () => {
  assert.equal(coarseCategory('bitcoin-something', undefined, 'Crypto'), 'crypto');
});

test('unknown slugs collapse to their first two tokens, not the whole slug', () => {
  assert.equal(coarseCategory('us-open-mens-final-2026'), 'us-open');
  assert.equal(coarseCategory(undefined, undefined), 'unknown');
});

test('is pure', () => {
  const a = coarseCategory('nfl-buf-kc-2026-01-11');
  for (let i = 0; i < 50; i++) assert.equal(coarseCategory('nfl-buf-kc-2026-01-11'), a);
});
```

Add the file to the `test` script in `package.json`.

## Migration note — put this in your report, do not act on it

Existing `ObservedTrade.marketCategory` rows hold raw slugs and will not match new coarse keys
until each wallet is re-profiled. `WalletProfile.categoryStrengthsJson` is rebuilt on every
`profileWallet` run, so this self-heals after one rescan generation. **Do not write a backfill
UPDATE** — say in `NOTED` that a rescan is required.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm test
diff src/lib/engine/category.ts ../dashboard/src/lib/engine/category.ts && \
diff src/lib/adapters/polymarket.ts ../dashboard/src/lib/adapters/polymarket.ts && \
diff src/lib/adapters/types.ts ../dashboard/src/lib/adapters/types.ts && echo "MIRROR OK"
```

Expected: `# fail 0` and `MIRROR OK`.
