# TASK-05 — `copyScore` multiplies ROI by zero

## Problem

In `src/lib/engine/tradeScoring.ts`:

```ts
  const w = rules.weights;
  const copyScore = clamp(
    walletQualityScore * w.roi + // wallet quality weighted under roi slot per spec weight list
      roiScore * 0 +
      consistencyScore * w.consistency +
      ...
      walletQualityScore * (1 - w.roi - w.consistency - w.copyability - w.categoryFit - w.entryTiming - w.spread - w.liquidity - w.thesis),
  );
```

Two dead terms:
- `roiScore * 0` — ROI is computed, returned in `scores`, written to
  `DecisionJournal.roiScore`, and contributes nothing to the decision.
- The final residual term. `DEFAULT_RULES.weights` sums to exactly `1.0`
  (`0.2 + 0.15 + 0.15 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1`), so `(1 - Σw)` is `0`.

Verify the sum yourself before editing:

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
node --experimental-strip-types -e "
import('./src/lib/engine/rules.ts').then(({DEFAULT_RULES:r}) =>
  console.log('weights sum =', Object.values(r.weights).reduce((a,b)=>a+b,0)));"
```

So `w.roi` (0.2 — the largest single weight) is spent on wallet quality, which is *already*
represented via `consistencyScore` and `copyabilityScore`. Wallet quality is triple-counted
and ROI is absent.

## Decision

Give ROI its own weight and stop overloading the `roi` slot. Rename the slot honestly, keep the
sum at 1.0, and delete the residual term.

New weights (sum = 1.00):

| key | old | new | rationale |
|---|---|---|---|
| `walletQuality` | — (was `roi`, 0.20) | 0.14 | still the largest single input, no longer triple-counted |
| `roi` | 0.20 (dead) | 0.10 | now actually applied |
| `consistency` | 0.15 | 0.14 | |
| `copyability` | 0.15 | 0.14 | |
| `categoryFit` | 0.10 | 0.10 | |
| `entryTiming` | 0.10 | 0.10 | |
| `spread` | 0.10 | 0.09 | |
| `liquidity` | 0.10 | 0.09 | |
| `thesis` | 0.10 | 0.10 | |

## Files to change

1. `/home/nima/.../runtime/src/lib/engine/rules.ts` — **MIRRORED**
2. `/home/nima/.../runtime/src/lib/engine/tradeScoring.ts` — **MIRRORED**

## Edit 1 — rules.ts, add the new weight key

BEFORE (must match exactly):
```ts
  weights: {
    roi: number;
    consistency: number;
```

AFTER:
```ts
  weights: {
    /** Wallet quality, previously smuggled into the `roi` slot. */
    walletQuality: number;
    roi: number;
    consistency: number;
```

BEFORE (must match exactly):
```ts
  weights: { roi: 0.2, consistency: 0.15, copyability: 0.15, categoryFit: 0.1, entryTiming: 0.1, spread: 0.1, liquidity: 0.1, thesis: 0.1 },
```

AFTER:
```ts
  // Sums to 1.00. Verified by tests/rules-weights.test.ts.
  weights: { walletQuality: 0.14, roi: 0.1, consistency: 0.14, copyability: 0.14, categoryFit: 0.1, entryTiming: 0.1, spread: 0.09, liquidity: 0.09, thesis: 0.1 },
```

In `getActiveRules`, next to the existing legacy backfills, add:
```ts
  // Legacy rule sets have no walletQuality weight; migrate the old overloaded `roi` slot.
  if (typeof rules.weights?.walletQuality !== 'number') {
    rules.weights = { ...DEFAULT_RULES.weights, ...rules.weights, walletQuality: DEFAULT_RULES.weights.walletQuality, roi: DEFAULT_RULES.weights.roi };
  }
```

## Edit 2 — tradeScoring.ts, apply every score once

BEFORE (must match exactly):
```ts
  const w = rules.weights;
  const copyScore = clamp(
    walletQualityScore * w.roi + // wallet quality weighted under roi slot per spec weight list
      roiScore * 0 +
      consistencyScore * w.consistency +
      copyabilityScore * w.copyability +
      categoryFitScore * w.categoryFit +
      entryTimingScore * w.entryTiming +
      spreadScore * w.spread +
      liquidityScore * w.liquidity +
      thesisScore * w.thesis +
      walletQualityScore * (1 - w.roi - w.consistency - w.copyability - w.categoryFit - w.entryTiming - w.spread - w.liquidity - w.thesis),
  );
```

AFTER:
```ts
  const w = rules.weights;
  // Every component appears exactly once, each under its own weight. Weights sum to 1.0,
  // so copyScore spans the full 0..1 range and minCopyScore is comparable across versions.
  const copyScore = clamp(
    walletQualityScore * w.walletQuality +
      roiScore * w.roi +
      consistencyScore * w.consistency +
      copyabilityScore * w.copyability +
      categoryFitScore * w.categoryFit +
      entryTimingScore * w.entryTiming +
      spreadScore * w.spread +
      liquidityScore * w.liquidity +
      thesisScore * w.thesis,
  );
```

## Edit 3 — new test file

Create `/home/nima/.../runtime/tests/rules-weights.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES } from '../src/lib/engine/rules.ts';

test('weights sum to exactly 1.0', () => {
  const sum = Object.values(DEFAULT_RULES.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}, must be 1.0`);
});

test('every weight is applied exactly once in copyScore', () => {
  const src = require('node:fs').readFileSync(
    new URL('../src/lib/engine/tradeScoring.ts', import.meta.url), 'utf8');
  for (const key of Object.keys(DEFAULT_RULES.weights)) {
    const hits = src.match(new RegExp(`w\\.${key}\\b`, 'g')) ?? [];
    assert.equal(hits.length, 1, `w.${key} used ${hits.length} times, expected 1`);
  }
  assert.ok(!/\*\s*0\s*\+/.test(src), 'a score is still multiplied by zero');
});
```

Add it to the `test` script in `runtime/package.json`.

## Expected behavioural change

Copy scores shift. Re-check that `minCopyScore: 0.65` still admits good setups: the existing
test `trade scoring: clean setup on strong wallet = paper_copy` must stay green. **If it goes
red, report it — do not lower `minCopyScore` to make it pass.** Threshold retuning is a
separate, evidence-driven decision.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm test
diff src/lib/engine/rules.ts ../dashboard/src/lib/engine/rules.ts && \
diff src/lib/engine/tradeScoring.ts ../dashboard/src/lib/engine/tradeScoring.ts && echo "MIRROR OK"
```

Expected: `# fail 0` and `MIRROR OK`.
