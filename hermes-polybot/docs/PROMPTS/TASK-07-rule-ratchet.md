# TASK-07 — Auto-rules only tighten, and re-read all history every run

**Do TASK-05 first** — the weight rework changes the evidence shape.

## Problem

`autoUpdateRules` in `src/lib/engine/rules.ts` has three defects that compound:

**1. One-directional.** Every mutation tightens:
```ts
      mutate: (r) => { r.maxSpread = Math.max(0.01, Math.round(r.maxSpread * 0.8 * 100) / 100); },
      mutate: (r) => { r.minLiquidity = Math.round(r.minLiquidity * 1.25); },
      mutate: (r) => { r.maxPriceMoveSinceEntry = Math.max(0.02, Math.round(r.maxPriceMoveSinceEntry * 0.8 * 100) / 100); },
```
Nothing ever loosens. `minLiquidity` has no ceiling at all.

**2. No cursor.** The evidence query reads every resolved paper trade ever:
```ts
  const rows = await db`SELECT pt."realizedPnl" AS pnl, dj."spreadScore", dj."liquidityScore", dj."entryTimingScore"
       FROM "PaperTrade" pt JOIN "DecisionJournal" dj ON dj."id" = pt."decisionJournalId"
       WHERE pt."status" = 'resolved' AND pt."realizedPnl" IS NOT NULL`;
```
The same historical losses re-trigger the same tightening on every invocation, until the bucket
average turns non-negative — which it cannot, because the trades are immutable. The system
ratchets itself to zero signals and calls it self-improvement.

**3. Wallet downgrades are permanent.** `status` moves to `ignore` and nothing restores it.

Net effect: the "self-improving" loop can only ever shrink. That contradicts its purpose.

## Design

Three changes, all bounded and auditable:

- **Bounds table.** Every tunable gets an explicit `[min, max]`. Mutations clamp to it.
- **Evidence window.** Only consider trades resolved since the active rule set was created.
  A rule change is judged on outcomes produced *under that rule*, not under its predecessors.
- **Symmetric adjustment.** A bucket that performs *well* loosens the threshold by the inverse
  factor, subject to the same bounds and the same minimum-sample requirement.

Wallet reinstatement is out of scope for this card — note it, do not build it.

## File to change

`/home/nima/.../runtime/src/lib/engine/rules.ts` — **MIRRORED**

## Edit 1 — bounds table

Insert immediately after `DEFAULT_RULES`:

```ts
/** Hard bounds for every auto-tunable threshold. Auto-updates clamp to these; a runaway
 * ratchet in either direction is a worse failure than a slightly wrong threshold. */
export const RULE_BOUNDS = {
  maxSpread: [0.01, 0.12],
  minLiquidity: [250, 100_000],
  maxPriceMoveSinceEntry: [0.02, 0.15],
  minCopyScore: [0.5, 0.85],
  minWatchScore: [0.3, 0.7],
  minShortTermShare: [0.25, 0.9],
} as const satisfies Record<string, readonly [number, number]>;

export function clampRule(key: keyof typeof RULE_BOUNDS, value: number): number {
  const [min, max] = RULE_BOUNDS[key];
  return Math.min(max, Math.max(min, value));
}
```

## Edit 2 — window the evidence

BEFORE (must match exactly):
```ts
  const rows = await db`SELECT pt."realizedPnl" AS pnl, dj."spreadScore", dj."liquidityScore", dj."entryTimingScore"
       FROM "PaperTrade" pt JOIN "DecisionJournal" dj ON dj."id" = pt."decisionJournalId"
       WHERE pt."status" = 'resolved' AND pt."realizedPnl" IS NOT NULL`;
```

AFTER:
```ts
  // Only outcomes produced UNDER the active rule set count as evidence about it. Without this
  // window the same historical losses re-trigger the same tightening on every single run.
  const [activeSince] = await db<Array<{ createdAt: string }>>`
    SELECT "createdAt"::text AS "createdAt" FROM "RuleSet" WHERE "active" = 1 ORDER BY "version" DESC LIMIT 1
  `;
  const since = activeSince?.createdAt ?? '1970-01-01';
  const rows = await db`SELECT pt."realizedPnl" AS pnl, dj."spreadScore", dj."liquidityScore", dj."entryTimingScore"
       FROM "PaperTrade" pt JOIN "DecisionJournal" dj ON dj."id" = pt."decisionJournalId"
       WHERE pt."status" = 'resolved' AND pt."realizedPnl" IS NOT NULL
         AND pt."resolvedAt" >= ${since}`;
```

## Edit 3 — symmetric, clamped adjustment

Replace each of the three `if (…) { … }` blocks with the paired form. The spread block becomes:

```ts
  const spreadBucket = rows.filter((r) => (r.spreadScore ?? 1) < 0.5);
  if (spreadBucket.length >= 3) {
    const mean = avg(spreadBucket.map((r) => r.pnl));
    const oldV = rules.maxSpread;
    const next = clampRule('maxSpread', mean < 0 ? oldV * 0.8 : oldV * 1.1);
    if (Math.abs(next - oldV) > 1e-9) {
      await applyRuleChange(db, {
        reason: mean < 0
          ? 'Spread-heavy trades underperform; tighten max spread'
          : 'Spread-heavy trades are profitable; allow slightly wider spreads',
        evidenceSummary: `${spreadBucket.length} resolved trades with low spread score averaged ${mean.toFixed(2)} PnL since rule set became active`,
        expectedImprovement: mean < 0 ? 'Fewer spread losses' : 'More qualifying signals without giving up edge',
        mutate: (r) => { r.maxSpread = Math.round(next * 100) / 100; },
      });
      changes.push(`maxSpread ${oldV} -> ${Math.round(next * 100) / 100}`);
    }
  }
```

Apply the same pattern to `minLiquidity` (tighten `× 1.25`, loosen `× 0.9`, clamp
`'minLiquidity'`) and `maxPriceMoveSinceEntry` (tighten `× 0.8`, loosen `× 1.1`, clamp
`'maxPriceMoveSinceEntry'`).

Keep the `if (rows.length < 5) return changes;` guard and the `>= 3` per-bucket minimum
exactly as they are. Loosening on thin evidence is how you get a runaway in the other direction.

## Edit 4 — test

Create `/home/nima/.../runtime/tests/rule-bounds.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULE_BOUNDS, clampRule, DEFAULT_RULES } from '../src/lib/engine/rules.ts';

test('clampRule respects both ends of every bound', () => {
  for (const key of Object.keys(RULE_BOUNDS) as Array<keyof typeof RULE_BOUNDS>) {
    const [min, max] = RULE_BOUNDS[key];
    assert.equal(clampRule(key, min - 1000), min, `${key} lower bound`);
    assert.equal(clampRule(key, max + 1000), max, `${key} upper bound`);
    assert.ok(min < max, `${key} bounds must be ordered`);
  }
});

test('every default sits inside its bounds', () => {
  for (const key of Object.keys(RULE_BOUNDS) as Array<keyof typeof RULE_BOUNDS>) {
    const [min, max] = RULE_BOUNDS[key];
    const v = (DEFAULT_RULES as any)[key];
    assert.ok(v >= min && v <= max, `${key} default ${v} outside [${min}, ${max}]`);
  }
});
```

Add it to the `test` script.

## Rules

- Never remove the audit trail. Every change must still go through `applyRuleChange`, which
  writes the `RuleChange` row with reason, evidence, before/after, and expected improvement.
- Do not auto-tune `maxTimeToResolutionHours`. The 24h short-term ceiling is a product
  decision, not a fitted parameter.
- Do not touch the wallet-downgrade query in this card.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm test
diff src/lib/engine/rules.ts ../dashboard/src/lib/engine/rules.ts && echo "MIRROR OK"
```

Expected: `# fail 0` and `MIRROR OK`. `npm run test:db` additionally exercises
`autoUpdateRules` against a real database if you have `DATABASE_URL`.
