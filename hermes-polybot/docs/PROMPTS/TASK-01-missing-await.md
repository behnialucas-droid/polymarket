# TASK-01 — Two scripts forget `await`

## Problem

`autoUpdateRules`, `getActiveRules`, and `buildDailyReport` are all `async`. Two CLI scripts
call them without `await` and then use the Promise as if it were the value.

Consequences, both silent:
- `update-rules.ts` — `changes` is a Promise. `changes.length` is `undefined`, and
  `if (undefined)` is falsy, so the script always prints the "no rule changes" branch. The
  rule changes still get applied inside the function, but the operator is told nothing happened.
- `report-daily.ts` — `report.summary` is `undefined` on a Promise, so the Telegram message
  literally contains the text `undefined`, and `saveDailyReport` is handed a Promise.

## Files to change

1. `/home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime/scripts/update-rules.ts`
2. `/home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime/scripts/report-daily.ts`

Neither is mirrored. Do not touch `dashboard/`.

## Edit 1 — update-rules.ts

BEFORE (must match exactly):
```ts
const db = getDb();
const changes = autoUpdateRules(db);
const { version } = getActiveRules(db);
```

AFTER:
```ts
const db = getDb();
const changes = await autoUpdateRules(db);
const { version } = await getActiveRules(db);
```

## Edit 2 — report-daily.ts

BEFORE (must match exactly):
```ts
const report = buildDailyReport(db, date);
```

AFTER:
```ts
const report = await buildDailyReport(db, date);
```

BEFORE (must match exactly):
```ts
saveDailyReport(db, report, sent, process.env.DATA_SOURCE === 'demo');
```

AFTER:
```ts
await saveDailyReport(db, report, sent, process.env.DATA_SOURCE === 'demo');
```

## Check first

Before editing, confirm the three functions really are async:

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "export async function autoUpdateRules\|export async function getActiveRules" src/lib/engine/rules.ts
grep -n "export async function buildDailyReport\|export async function saveDailyReport" src/lib/engine/reports.ts
```

If `saveDailyReport` is **not** async, skip the fourth edit and say so in `NOTED`.

## Acceptance

- Every call to an `async` function in both scripts is awaited.
- No other line changed.
- No `.then()` chains introduced.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "autoUpdateRules\|getActiveRules\|buildDailyReport\|saveDailyReport" scripts/update-rules.ts scripts/report-daily.ts
npm test
```

Expected: every grep hit that is a call site is preceded by `await`; `npm test` reports
`# fail 0`.

Running the scripts themselves requires a live `DATABASE_URL`. If you have one, run
`npm run -s cycle` is **not** a substitute — do not run it. Report the grep + `npm test`
output only.
