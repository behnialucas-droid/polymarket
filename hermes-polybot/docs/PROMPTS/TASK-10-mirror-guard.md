# TASK-10 — Nothing prevents `runtime/` and `dashboard/` from drifting

## Problem

`runtime/src/lib/` and `dashboard/src/lib/` hold the same engine. Two copies, no enforcement.

This already caused a real divergence: `rules.ts` shipped with
`maxTimeToResolutionHours: 24 * 60` (60 days) in the dashboard while the runtime had `24`
(1 day). The dashboard therefore rendered decisions under a rule set the engine was not using,
and nobody noticed until the trees were diffed by hand.

`AGENTS.md` states Postgres is the single source of truth for *state*. There is no equivalent
statement for *code*, and no check.

## Decision

Add a check, not a build system. Extracting a shared package means a workspace, a version, and
a publish step for a two-package repo — disproportionate. A 30-line assertion script that runs
in `npm test` and in CI gets the whole benefit.

There is already a precedent for this style: `scripts/assert-one-dep.ts`. Read it first and
match its shape.

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
cat scripts/assert-one-dep.ts
```

## Files to change

1. **New file** `/home/nima/.../runtime/scripts/assert-mirror.ts`
2. `/home/nima/.../runtime/package.json`
3. `/home/nima/.../polymarket-repo/.github/workflows/ci.yml`

## Edit 1 — the check

Create `runtime/scripts/assert-mirror.ts`:

```ts
/**
 * The dashboard carries a byte-identical copy of the engine. Nothing but this check stops the
 * two from drifting — and they have drifted before, shipping two different rule sets at once.
 *
 * Exits non-zero with a diff-friendly report. Add a file to MIRRORED whenever a new module is
 * shared; a file present in one tree and absent in the other is also a failure.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = join(RUNTIME, '..', 'dashboard');

const MIRRORED = [
  'src/lib/adapters/types.ts',
  'src/lib/adapters/polymarket.ts',
  'src/lib/adapters/http.ts',
  'src/lib/adapters/rateLimit.ts',
  'src/lib/adapters/index.ts',
  'src/lib/engine/horizon.ts',
  'src/lib/engine/rules.ts',
  'src/lib/engine/tradeScoring.ts',
  'src/lib/engine/walletScoring.ts',
  'src/lib/engine/paperTrading.ts',
  'src/lib/engine/reports.ts',
  'src/lib/classify.ts',
  'src/lib/env.ts',
  'src/lib/telegram.ts',
  'src/lib/heartbeat.ts',
  'src/lib/failures.ts',
  'src/lib/rescan.ts',
  'src/lib/memory/render.ts',
  'src/lib/memory/publish.ts',
];

const problems: string[] = [];

for (const rel of MIRRORED) {
  const a = join(RUNTIME, rel);
  const b = join(DASHBOARD, rel);
  if (!existsSync(a)) { problems.push(`missing in runtime:   ${rel}`); continue; }
  if (!existsSync(b)) { problems.push(`missing in dashboard: ${rel}`); continue; }
  if (readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) {
    problems.push(`DRIFT: ${rel}\n    diff runtime/${rel} dashboard/${rel}`);
  }
}

if (problems.length) {
  console.error(`mirror check FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error('  -', p);
  console.error('\nFix by copying the authoritative version, then re-run. runtime/ is authoritative.');
  process.exit(1);
}
console.log(`mirror check OK (${MIRRORED.length} files identical)`);
```

## Edit 2 — wire into `npm test`

In `runtime/package.json`, BEFORE (must match the current value; the trailing test files may
differ if later cards added more — preserve whatever is there):
```json
    "test": "node --experimental-strip-types --test tests/secrets.test.ts
```

Add a separate script rather than editing the test list:
```json
    "mirror": "node --experimental-strip-types scripts/assert-mirror.ts",
```
and prefix the existing `test` value with `npm run mirror && `, keeping the rest of the command
byte-identical.

## Edit 3 — CI

Read `ci.yml` first:
```bash
cat /home/nima/Documents/claude.app/polymarket-repo/.github/workflows/ci.yml
```
Add a step that runs `npm run mirror` in `hermes-polybot/runtime`, placed **before** the test
step so drift is reported as its own failure rather than buried in test output. Match the
indentation and the `working-directory` convention already used in that file. If the file's
structure does not match what this card assumes, **STOP** and report what it actually contains.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm run mirror
npm test

# Prove the check actually catches drift:
printf '\n// deliberate drift\n' >> ../dashboard/src/lib/engine/rules.ts
npm run mirror; echo "exit=$?"
git -C /home/nima/Documents/claude.app/polymarket-repo checkout -- hermes-polybot/dashboard/src/lib/engine/rules.ts
npm run mirror
```

Expected: passes, then `exit=1` with `DRIFT: src/lib/engine/rules.ts`, then passes again after
the revert. **Include the failing run in your report** — a guard you have not seen fail is a
guard you have not tested.
