# TASK-02 — `classify()` compares a 0..1 score against 70

## Problem

`WalletProfile.globalScore` is produced by `scoreWallet()` and is always in **0..1**
(`walletScoring.ts` ends with `Math.round(globalScore * 100) / 100`). `classify()` was written
against a 0..100 scale:

```ts
[p.globalScore >= 70, `score ${p.globalScore.toFixed(1)} < 70`],
```

A real score of `0.82` fails `>= 70`, so that gate never passes. Combined with the hysteresis
branch (`p.globalScore >= 65`), **`classify()` can never return `copy`**. Every wallet ends up
`watch` or `ignore`, and `memoryStatus` — which drives the `memory/` projection that agents
read per `AGENTS.md` — is permanently wrong.

Prove it before you change anything:

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "globalScore" src/lib/engine/walletScoring.ts | tail -3
grep -n "70\|65\|55" src/lib/classify.ts
```

## Decision

Normalise **inside `classify()`**, not at the call site. `classify` is the pure, git-diffed
function; making it tolerant of both scales keeps every caller correct and keeps the
thresholds readable as percentages.

## File to change

`/home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime/src/lib/classify.ts`

**MIRRORED** — apply the identical change to
`/home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/dashboard/src/lib/classify.ts`.

## Edit

BEFORE (must match exactly):
```ts
export function classify(
  p: ClassificationProfileInput,
  previous?: MemoryStatus
): Decision {
  const r: string[] = [];
```

AFTER:
```ts
/**
 * Wallet scores are produced on a 0..1 scale by scoreWallet(), but the gates below are
 * expressed as percentages. Accept either: anything <= 1 is treated as a fraction.
 * Kept inside classify so the function stays the single place the scale is defined.
 */
function toPercent(score: number): number {
  return score <= 1 ? score * 100 : score;
}

export function classify(
  p: ClassificationProfileInput,
  previous?: MemoryStatus
): Decision {
  const r: string[] = [];
  const score = toPercent(p.globalScore);
```

Then replace **every** remaining use of `p.globalScore` in this function with `score`.
There are exactly three, in these lines:

```ts
    [p.globalScore >= 70, `score ${p.globalScore.toFixed(1)} < 70`],
```
```ts
  if (previous === 'copy' && r.length <= 1 && p.globalScore >= 65) {
```
```ts
      reason: `score ${p.globalScore.toFixed(1)}, ${p.tradeCount30d} trades, consistency ${p.consistency.toFixed(2)}`,
```
```ts
  if (r.length <= 2 && p.globalScore >= 55) {
```

(That is four occurrences across four lines — replace all of them with `score`.)

Do **not** change the numbers 70 / 65 / 55. Do **not** change any other gate.

## Constraint

`classify` must stay pure: no `Date.now()`, no randomness, no I/O. The existing test
`classify — pure function determinism (100 runs over fixed input)` enforces this.

## Acceptance

- `classify({ ...validProfile, globalScore: 0.85 })` returns `copy`.
- `classify({ ...validProfile, globalScore: 85 })` still returns `copy` (back-compat).
- `runtime` and `dashboard` copies are byte-identical.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm test
diff src/lib/classify.ts ../dashboard/src/lib/classify.ts && echo "MIRROR OK"
node --experimental-strip-types -e "
import('./src/lib/classify.ts').then(({classify}) => {
  const base = { address:'0xa', globalScore:0.85, tradeCount30d:25, resolvedTradeCount30d:20,
    realizedPnl30d:1500, consistency:0.75, maxDrawdown30d:0.12, daysSinceLastTrade:2,
    oneHitWonderFlag:false, topTradePnlShare:0.15, shortTermShare:0.8 };
  console.log('0..1 scale:', classify(base).status);
  console.log('0..100 scale:', classify({...base, globalScore:85}).status);
});"
```

Expected: `npm test` shows `# fail 0`; `MIRROR OK`; both scales print `copy`.

## Note

After this card lands, `memoryStatus` starts returning `copy` for the first time. The query in
`scripts/pipeline.ts` (`WHERE "memoryStatus" IN ('copy','watch') OR "status" IN (...)`) will
therefore begin selecting a different wallet set. That is the intended effect — do not
"compensate" for it elsewhere.
