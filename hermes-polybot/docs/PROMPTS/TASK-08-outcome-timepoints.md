# TASK-08 — 1h/6h/24h prices read by array index instead of timestamp

## Problem

`src/lib/engine/paperTrading.ts`, inside `reviewOutcomes`:

```ts
      const snaps = await db`SELECT "price" FROM "PnlSnapshot" WHERE "paperTradeId" = ${t.id} ORDER BY "collectedAt" LIMIT 24`;
```

then:

```ts
        VALUES (${t.decisionJournalId}, ${t.id}, CURRENT_TIMESTAMP, ${snaps[0]?.price ?? null}, ${snaps[5]?.price ?? null}, ${snaps[23]?.price ?? null}, ...
```

`snaps[0]`, `snaps[5]`, `snaps[23]` are only "1h, 6h, 24h" if snapshots land exactly hourly with
no gaps. They do not: `updateOpenPnl` catches per-trade errors and skips the snapshot write, so
any failed price fetch shifts every later index. Worse, with the short-term filter in place most
positions resolve inside 24h and never accumulate 24 snapshots, so `priceAfter24h` is usually
`null` while `priceAfter6h` may actually be a 90-minute reading.

The columns are then used to judge decision quality. Mislabelled inputs produce mislabelled
lessons, which feed the rule updater.

## Decision

Select by elapsed time relative to the trade's own creation, not by row position. Pick the
snapshot nearest each target that is within a tolerance window; emit `null` when no snapshot
falls in the window, rather than substituting a wrong one.

## File to change

`/home/nima/.../runtime/src/lib/engine/paperTrading.ts` — **MIRRORED** to
`dashboard/src/lib/engine/paperTrading.ts`

## Edit 1 — helper

Insert above `export async function reviewOutcomes`:

```ts
/**
 * Nearest snapshot to `targetHours` after `openedAt`, within +/- tolerance.
 * Returns null rather than a wrong-but-available price: a mislabelled data point is worse
 * than a missing one, because downstream code cannot tell it is wrong.
 */
function priceAtHours(
  snaps: Array<{ price: number; collectedAt: string }>,
  openedAtMs: number,
  targetHours: number,
  toleranceHours = 0.5,
): number | null {
  let best: { price: number; delta: number } | null = null;
  for (const s of snaps) {
    const h = (new Date(s.collectedAt).getTime() - openedAtMs) / 3.6e6;
    const delta = Math.abs(h - targetHours);
    if (delta <= toleranceHours && (best === null || delta < best.delta)) {
      best = { price: Number(s.price), delta };
    }
  }
  return best?.price ?? null;
}
```

## Edit 2 — select timestamps too

BEFORE (must match exactly):
```ts
      const snaps = await db`SELECT "price" FROM "PnlSnapshot" WHERE "paperTradeId" = ${t.id} ORDER BY "collectedAt" LIMIT 24`;
```

AFTER:
```ts
      const snaps = await db<Array<{ price: number; collectedAt: string }>>`
        SELECT "price", "collectedAt"::text AS "collectedAt"
          FROM "PnlSnapshot" WHERE "paperTradeId" = ${t.id} ORDER BY "collectedAt"
      `;
      const openedAtMs = new Date(t.createdAt ?? t.openedAt ?? Date.now()).getTime();
      // Widen tolerance with the horizon: a 24h check point is inherently coarser than a 1h one.
      const p1h = priceAtHours(snaps, openedAtMs, 1, 0.5);
      const p6h = priceAtHours(snaps, openedAtMs, 6, 1);
      const p24h = priceAtHours(snaps, openedAtMs, 24, 2);
```

## Edit 3 — use the computed values

BEFORE (must match exactly):
```ts
        VALUES (${t.decisionJournalId}, ${t.id}, CURRENT_TIMESTAMP, ${snaps[0]?.price ?? null}, ${snaps[5]?.price ?? null}, ${snaps[23]?.price ?? null}, ${m.resolvedOutcome ?? null}, ${pnl}, ${pnl > 0 ? 1 : 0}, ${JSON.stringify(lessons)})
```

AFTER:
```ts
        VALUES (${t.decisionJournalId}, ${t.id}, CURRENT_TIMESTAMP, ${p1h}, ${p6h}, ${p24h}, ${m.resolvedOutcome ?? null}, ${pnl}, ${pnl > 0 ? 1 : 0}, ${JSON.stringify(lessons)})
```

## Before you edit — confirm the column name

`t` comes from `SELECT * FROM "PaperTrade"`. Check which timestamp column actually exists:

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n -A20 'CREATE TABLE IF NOT EXISTS "PaperTrade"' db/migrations/001_init.sql
```

If the column is neither `createdAt` nor `openedAt`, **STOP** and report the actual column name.
Do not guess and do not leave the `?? Date.now()` fallback as the real path — that fallback
exists only to keep types honest.

## Acceptance

- No array-index access into `snaps` anywhere in the file.
- A trade with a gap in its snapshot series still reports correct time points, or `null`.
- `npm test` green; mirror identical.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "snaps\[" src/lib/engine/paperTrading.ts
npm test
diff src/lib/engine/paperTrading.ts ../dashboard/src/lib/engine/paperTrading.ts && echo "MIRROR OK"
```

Expected: the grep returns nothing; `# fail 0`; `MIRROR OK`.
