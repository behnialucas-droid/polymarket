# TASK-03 — `classify()` is fed two hardcoded numbers

**Do TASK-02 first.** This card assumes the scale fix has landed.

## Problem

`scripts/rescan-chunk.ts` builds the input to `classify()` from the wallet profile row, except
for two fields it invents:

```ts
            maxDrawdown30d: 0.15, // fallback estimate if not present
            daysSinceLastTrade: 1,
```

`0.15` always passes the `maxDrawdown30d <= 0.35` gate and `1` always passes both
`daysSinceLastTrade <= 7` and the `> 21` hard disqualifier. Two of the five gates and one of
the four hard disqualifiers are therefore decorative — a wallet that has been dormant for two
months still classifies as active.

This also violates the project's own rule against fabricated data: these are invented values
presented to a pure function as if they were measurements.

## What is actually available

`WalletProfile` has no drawdown column and no last-trade column. But `ObservedTrade` has real
timestamps, and `PaperTrade` has realised PnL per wallet. Compute both from the database.

Check what exists before you write the query:

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "daysSinceLastTrade\|maxDrawdown" db/migrations/*.sql src/lib/classify.ts
grep -n "CREATE TABLE" db/migrations/001_init.sql
```

## File to change

`/home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime/scripts/rescan-chunk.ts`

Not mirrored — `scripts/` exists only in `runtime/`.

## Edit

Locate this block (must match exactly):

```ts
            maxDrawdown30d: 0.15, // fallback estimate if not present
            daysSinceLastTrade: 1,
```

Replace with:

```ts
            maxDrawdown30d: metrics.maxDrawdown30d,
            daysSinceLastTrade: metrics.daysSinceLastTrade,
```

Then, immediately **before** the `const decision = classify(` line, insert the measurement:

```ts
        // Real measurements, not estimates. A wallet with no observed trades is treated as
        // maximally stale so it fails the inactivity gate rather than sailing through it.
        const [act] = await db<Array<{ lastTs: string | null }>>`
          SELECT MAX("timestamp") AS "lastTs" FROM "ObservedTrade" WHERE "walletAddress" = ${address}
        `;
        const [dd] = await db<Array<{ worst: number | null; best: number | null }>>`
          SELECT MIN("cum") AS worst, MAX("cum") AS best FROM (
            SELECT SUM("realizedPnl") OVER (ORDER BY "resolvedAt") AS cum
              FROM "PaperTrade"
             WHERE "walletAddress" = ${address} AND "status" = 'resolved' AND "realizedPnl" IS NOT NULL
          ) s
        `;
        const peak = Number(dd?.best ?? 0);
        const trough = Number(dd?.worst ?? 0);
        const metrics = {
          daysSinceLastTrade: act?.lastTs
            ? Math.floor((Date.now() - new Date(act.lastTs).getTime()) / 86_400_000)
            : 999,
          // Drawdown as a fraction of the equity peak. No peak (never profitable) -> 0,
          // which is honest: there is nothing to have drawn down from.
          maxDrawdown30d: peak > 0 ? Math.min(1, Math.max(0, (peak - trough) / peak)) : 0,
        };
```

## Rules

- Do not change `classify.ts`.
- Do not change any threshold.
- `999` for a wallet with no observed trades is deliberate: it must fail
  `daysSinceLastTrade > 21`, not pass it.
- Keep the existing `try`/`catch` structure of the surrounding loop intact.

## Acceptance

- No literal numeric value is passed for `maxDrawdown30d` or `daysSinceLastTrade`.
- A wallet with zero rows in `ObservedTrade` classifies as `ignore` with reason `inactive 999d`.
- `npm test` still green.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "maxDrawdown30d\|daysSinceLastTrade" scripts/rescan-chunk.ts
npm test
```

Expected: neither field is assigned a literal; `# fail 0`.

A live run needs `DATABASE_URL`. If you do not have one, say so — do not fake a run.
