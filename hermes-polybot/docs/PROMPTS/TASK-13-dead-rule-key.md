# TASK-13 — `minResolvedTrades` is declared but never read

## Problem

`Rules` declares it, `DEFAULT_RULES` sets it to `5`, and nothing reads it:

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot
grep -rn --include='*.ts' "minResolvedTrades" runtime dashboard | grep -v node_modules
```

Expect only the interface line and the default. A rule visible in the `/rules` dashboard page,
stored in every `RuleSet` row, and never applied is worse than no rule: an operator reading the
active rule set concludes the system requires 5 resolved trades before trusting a wallet, and it
does not.

The intent is sound and the gap is real. `walletScoring.ts` handles thin samples only indirectly:

```ts
  if (resolved.length > 0 && resolved.length < 5) oneHitWonderPenalty = clamp(oneHitWonderPenalty + 0.3); // few resolved trades = unreliable
```

That is a soft nudge with the threshold hardcoded to `5`, duplicating the rule value.

## Decision

Make the key real and remove the duplicated constant. A wallet below the resolved-trade minimum
cannot reach `track` — it can still be watched and can still accumulate history.

Soft gate, not deletion: a promising wallet with 3 resolved trades should keep being observed
until it has 5, not be discarded.

## File to change

`/home/nima/.../runtime/src/lib/engine/walletScoring.ts` — **MIRRORED**

## Edit 1 — thread the rule value in

BEFORE (must match exactly):
```ts
  if (resolved.length > 0 && resolved.length < 5) oneHitWonderPenalty = clamp(oneHitWonderPenalty + 0.3); // few resolved trades = unreliable
```

AFTER:
```ts
  // Thin samples are unreliable. Threshold comes from the active rule set (minResolvedTrades)
  // rather than a hardcoded 5, so the dashboard's stated rule matches actual behaviour.
  if (resolved.length > 0 && resolved.length < minResolvedTrades) {
    oneHitWonderPenalty = clamp(oneHitWonderPenalty + 0.3);
  }
```

BEFORE (must match exactly):
```ts
export function scoreWallet(items: TradeWithMarket[], maxHours = DEFAULT_SHORT_TERM_MAX_HOURS): WalletScore {
```

AFTER:
```ts
export function scoreWallet(
  items: TradeWithMarket[],
  maxHours = DEFAULT_SHORT_TERM_MAX_HOURS,
  minResolvedTrades = 5,
): WalletScore {
```

Then find the note that uses the same hardcoded value:
```ts
  if (resolved.length < 5) notes.push('few resolved trades');
```
and change `5` to `minResolvedTrades`.

## Edit 2 — enforce it in `walletStatus`

BEFORE (must match exactly):
```ts
export function walletStatus(
  s: WalletScore,
  minGlobalScore: number,
  minShortTermShare = 0.5,
): { status: 'track' | 'watch' | 'ignore'; reason: string } {
  const shortTermOk = s.shortTermShare >= minShortTermShare;
  if (s.globalScore >= minGlobalScore && s.oneHitWonderPenalty < 0.5 && s.copyabilityScore >= 0.4) {
```

AFTER:
```ts
export function walletStatus(
  s: WalletScore,
  minGlobalScore: number,
  minShortTermShare = 0.5,
  minResolvedTrades = 5,
): { status: 'track' | 'watch' | 'ignore'; reason: string } {
  const shortTermOk = s.shortTermShare >= minShortTermShare;
  const sampleOk = s.resolvedTradeCount30d >= minResolvedTrades;
  if (s.globalScore >= minGlobalScore && s.oneHitWonderPenalty < 0.5 && s.copyabilityScore >= 0.4) {
    if (!sampleOk) {
      return {
        status: 'watch',
        reason: `score ${s.globalScore} qualifies but only ${s.resolvedTradeCount30d} resolved trades (need ${minResolvedTrades})`,
      };
    }
```

Leave the rest of the function body unchanged.

## Edit 3 — pass it from the pipeline

In `/home/nima/.../runtime/scripts/pipeline.ts` (not mirrored):

BEFORE (must match exactly):
```ts
  const s = scoreWallet(items, rules.maxTimeToResolutionHours);
  const st = walletStatus(s, rules.minWalletGlobalScore, rules.minShortTermShare);
```

AFTER:
```ts
  const s = scoreWallet(items, rules.maxTimeToResolutionHours, rules.minResolvedTrades);
  const st = walletStatus(s, rules.minWalletGlobalScore, rules.minShortTermShare, rules.minResolvedTrades);
```

## Edit 4 — test

Append to `/home/nima/.../runtime/tests/scoring.test.ts`:

```ts
test('minResolvedTrades is enforced, not decorative', () => {
  const thin = scoreWallet(
    Array.from({ length: 3 }, (_, i) => item(0.3, { marketId: `m${i}` }, { liquidity: 80000, spread: 0.01 })),
    24, 5,
  );
  const st = walletStatus(thin, 0.5, 0.5, 5);
  assert.notEqual(st.status, 'track');
  assert.match(st.reason, /resolved trades/);
});
```

Note: with only 3 resolved trades the one-hit-wonder penalty also fires, so this wallet may fail
the outer condition first and land on the `watch`/`ignore` fallback. The assertion checks
`notEqual('track')` for exactly that reason. **Do not weaken the assertion to make it pass** — if
it fails, report the actual status and reason.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -rn --include='*.ts' "minResolvedTrades" src scripts | grep -v node_modules
npm test
diff src/lib/engine/walletScoring.ts ../dashboard/src/lib/engine/walletScoring.ts && echo "MIRROR OK"
```

Expected: the key now appears at read sites, not just the declaration; `# fail 0`; `MIRROR OK`.
