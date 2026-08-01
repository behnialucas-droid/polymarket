# TASK-14 — `bestCategory` can be the least-bad losing category

**Do TASK-06 first** — without stable category keys this fix has nothing to operate on.

## Problem

`src/lib/engine/walletScoring.ts`:

```ts
  const bestCategory = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
```

`byCat` holds **signed** PnL per category. `sort` picks the maximum. If a wallet lost money in
every category, the maximum is the smallest loss — and that category is still labelled "best".

`tradeScoring.ts` then rewards it:

```ts
    (trade.side === 'BUY' ? 0.6 : 0.3) + (trade.marketCategory === wallet.bestCategory ? 0.3 : 0) + ...
```

A `+0.3` thesis bonus for trading the category where the wallet loses least. The dashboard also
renders it as "Best category", stating something false to the operator.

There is a second issue in the same block. The comment claims 0..1, the values are -1..1:

```ts
  // category strengths: pnl by category (normalized 0..1)
  ...
  const categoryStrengths = Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, Math.round((v / catMax) * 100) / 100]));
```

`tradeScoring.ts` already compensates with `(strength + 1) / 2`, so the range is fine — only the
comment is wrong. Fix the comment; do **not** change the range, or you silently double-shift
every category score.

## Decision

`bestCategory` must be `null` unless the category is genuinely profitable and has more than one
observation. One winning trade in a category is not an edge.

## File to change

`/home/nima/.../runtime/src/lib/engine/walletScoring.ts` — **MIRRORED**

## Edit 1 — count observations alongside PnL

BEFORE (must match exactly):
```ts
  // category strengths: pnl by category (normalized 0..1)
  const byCat: Record<string, number> = {};
  for (const i of resolved) {
    const c = i.trade.marketCategory ?? 'unknown';
    byCat[c] = (byCat[c] ?? 0) + (i.pnlPerDollar ?? 0) * i.trade.size;
  }
  const catMax = Math.max(1, ...Object.values(byCat).map(Math.abs));
  const categoryStrengths = Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, Math.round((v / catMax) * 100) / 100]));
  const bestCategory = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
```

AFTER:
```ts
  // Category strengths: signed PnL per category, normalised to -1..1 (NOT 0..1 — tradeScoring
  // remaps with (v + 1) / 2, so changing this range would double-shift every category score).
  const byCat: Record<string, number> = {};
  const catCount: Record<string, number> = {};
  for (const i of resolved) {
    const c = i.trade.marketCategory ?? 'unknown';
    byCat[c] = (byCat[c] ?? 0) + (i.pnlPerDollar ?? 0) * i.trade.size;
    catCount[c] = (catCount[c] ?? 0) + 1;
  }
  const catMax = Math.max(1, ...Object.values(byCat).map(Math.abs));
  const categoryStrengths = Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, Math.round((v / catMax) * 100) / 100]));
  // "Best" must mean genuinely profitable, with more than one observation. Ranking signed PnL
  // and taking the max previously crowned the smallest loss when every category lost money —
  // and tradeScoring pays a +0.3 thesis bonus for matching it.
  const MIN_CATEGORY_SAMPLE = 2;
  const bestCategory =
    Object.entries(byCat)
      .filter(([c, v]) => v > 0 && (catCount[c] ?? 0) >= MIN_CATEGORY_SAMPLE)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
```

## Edit 2 — test

Append to `/home/nima/.../runtime/tests/scoring.test.ts`:

```ts
test('bestCategory is null when every category lost money', () => {
  const s = scoreWallet([
    item(-0.2, { marketId: 'a', marketCategory: 'politics' }),
    item(-0.2, { marketId: 'b', marketCategory: 'politics' }),
    item(-0.5, { marketId: 'c', marketCategory: 'sports' }),
    item(-0.5, { marketId: 'd', marketCategory: 'sports' }),
  ]);
  assert.equal(s.bestCategory, null);
});

test('bestCategory ignores single-observation categories', () => {
  const s = scoreWallet([
    item(2.0, { marketId: 'lucky', marketCategory: 'crypto-btc' }),   // one big win, n=1
    item(0.3, { marketId: 'p1', marketCategory: 'politics' }),
    item(0.3, { marketId: 'p2', marketCategory: 'politics' }),
    item(0.3, { marketId: 'p3', marketCategory: 'politics' }),
  ]);
  assert.equal(s.bestCategory, 'politics');
});
```

## Downstream effect — verify, do not "fix"

`bestCategory` becoming `null` more often means `thesisScore` loses its `+0.3` more often, so
copy scores drop for some trades. That is the point: the bonus was being paid on false pretences.
If `trade scoring: clean setup on strong wallet = paper_copy` goes red, **report it** — the
fixture's wallet may need a legitimately profitable category, but do not lower `minCopyScore`.

`WalletProfile.bestCategory` is recomputed on every `profileWallet` run, so no backfill is
needed. Rendered at `dashboard/app/wallets/page.tsx` and
`dashboard/app/wallets/[address]/page.tsx`; both already handle `null` via `?? '—'`. Confirm:

```bash
grep -n "bestCategory" /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/dashboard/app/wallets/page.tsx
```

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm test
diff src/lib/engine/walletScoring.ts ../dashboard/src/lib/engine/walletScoring.ts && echo "MIRROR OK"
```

Expected: `# fail 0` and `MIRROR OK`.
