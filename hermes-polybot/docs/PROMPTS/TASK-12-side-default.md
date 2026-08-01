# TASK-12 — A malformed trade row silently becomes a BUY

## Problem

`src/lib/adapters/polymarket.ts`, in `fetchWalletTrades`:

```ts
        side: (t.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
```

Any row where `side` is missing, null, or an unrecognised string becomes `'BUY'`. That is
fabricated data, which the project's own contract forbids. Direction is not a cosmetic field:

- `thesisScore` gives `0.6` for BUY and `0.3` for SELL.
- A SELL misread as a BUY inverts the meaning of the signal being copied.
- The value is persisted to `ObservedTrade.side` and to the `tradeHash` used for deduplication,
  so a bad guess becomes permanent.

The same function has a related weakness: `price: Number(t.price)` and
`size: Number(t.usdcSize ?? t.size ?? 0)` produce `NaN` and `0` respectively on malformed input,
also without complaint.

## Decision

Reject the row instead of guessing. Return only well-formed trades and report how many were
dropped, so a malformed upstream response is visible rather than silently absorbed.

Dropping is correct here rather than throwing: one bad row in a 500-row activity response must
not discard the other 499, but it must also not be invented.

## File to change

`/home/nima/.../runtime/src/lib/adapters/polymarket.ts` — **MIRRORED**

## Edit

BEFORE (must match exactly):
```ts
    return (rows ?? [])
      .filter((t) => Number(t.timestamp) >= sinceTs)
      .map((t) => ({
        walletAddress: address,
        marketId: String(t.market ?? t.conditionId ?? ''),
        conditionId: t.conditionId,
        marketQuestion: t.title ?? t.question,
        marketCategory: t.eventSlug ?? t.category,
        outcome: t.outcome,
        side: (t.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        price: Number(t.price),
        size: Number(t.usdcSize ?? t.size ?? 0),
        timestamp: new Date(Number(t.timestamp) * 1000).toISOString(),
        raw: t,
      }));
```

AFTER:
```ts
    const dropped: string[] = [];
    const out: WalletTrade[] = [];
    for (const t of rows ?? []) {
      if (!(Number(t.timestamp) >= sinceTs)) continue;

      // Direction is never guessed. It decides what signal we think we are copying, it feeds
      // thesisScore, and it is baked into tradeHash — a wrong guess is permanent.
      const rawSide = String(t.side ?? '').toUpperCase();
      if (rawSide !== 'BUY' && rawSide !== 'SELL') {
        dropped.push(`side=${JSON.stringify(t.side)}`);
        continue;
      }
      const price = Number(t.price);
      if (!Number.isFinite(price) || price <= 0 || price > 1) {
        dropped.push(`price=${JSON.stringify(t.price)}`);
        continue;
      }
      const size = Number(t.usdcSize ?? t.size);
      if (!Number.isFinite(size) || size <= 0) {
        dropped.push(`size=${JSON.stringify(t.usdcSize ?? t.size)}`);
        continue;
      }
      const marketId = String(t.market ?? t.conditionId ?? '');
      if (!marketId) {
        dropped.push('marketId=empty');
        continue;
      }

      out.push({
        walletAddress: address,
        marketId,
        conditionId: t.conditionId,
        marketQuestion: t.title ?? t.question,
        marketCategory: t.eventSlug ?? t.category,
        outcome: t.outcome,
        side: rawSide,
        price,
        size,
        timestamp: new Date(Number(t.timestamp) * 1000).toISOString(),
        raw: t,
      });
    }
    if (dropped.length) {
      console.warn(
        `[polymarket] dropped ${dropped.length} malformed activity row(s) for ${address}: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? ' …' : ''}`,
      );
    }
    return out;
```

## Interaction with TASK-06

If TASK-06 has already landed, the `marketCategory` line will read
`coarseCategory(t.eventSlug, t.title ?? t.question, t.category)` and there will be an
`eventSlug: t.eventSlug,` line. **Preserve whatever is currently there** — do not revert it to
the raw-slug form shown in the BEFORE block above. If the anchor does not match because of
TASK-06, adapt only that one line and say so in your report.

## Rules

- `price > 1` is invalid: Polymarket prices are probabilities in `(0, 1]`.
- Do not throw. One malformed row must not discard the whole response.
- Do not log `t` in full — it may contain wallet identifiers. Log only the offending field.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "?? 'BUY'" src/lib/adapters/polymarket.ts
npm test
diff src/lib/adapters/polymarket.ts ../dashboard/src/lib/adapters/polymarket.ts && echo "MIRROR OK"
```

Expected: the grep returns nothing; `# fail 0`; `MIRROR OK`.

Add a unit test only if `tests/` already contains an adapter test to extend. If it does not,
say so in `NOTED` — creating an adapter test harness is a separate task.
