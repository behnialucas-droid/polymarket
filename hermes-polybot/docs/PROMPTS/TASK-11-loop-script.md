# TASK-11 — `loop.ts` spawns a file that does not exist

## Problem

`runtime/scripts/loop.ts` is the "SMC daemon". Every 5 minutes it does:

```ts
      const res = spawnSync('node', [
        '--env-file=.env', 
        '--experimental-strip-types', 
        '--disable-warning=ExperimentalWarning', 
        path.join(root, 'scripts', 'loop-once.ts')
      ], { 
```

`scripts/loop-once.ts` does not exist in this tree. It exists only in the abandoned copy at
`/home/nima/Documents/claude.app/hermes-polybot/scripts/`. Confirm:

```bash
ls /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime/scripts/
```

Two further problems in the same file:
- `spawnSync` failure is logged but the loop continues forever with no backoff and no
  consecutive-failure limit — a broken cycle produces one identical error every 5 minutes
  indefinitely.
- `path.resolve(process.cwd())` means the daemon only works when launched from `runtime/`.

The real orchestrator in this tree is `scripts/cycle.ts`, which already takes a `RunLock` lease,
runs monitor → score → PnL → outcomes → heartbeat, and exits 0 on lock contention.

## Decision

Point the loop at `cycle.ts`, resolve paths from the script's own location, and give up after
repeated consecutive failures instead of looping on a broken system forever.

## File to change

`/home/nima/.../runtime/scripts/loop.ts` — not mirrored.

## Edit 1 — resolve root from the module, not the cwd

BEFORE (must match exactly):
```ts
import { spawnSync } from 'node:child_process';
import path from 'node:path';
```

AFTER:
```ts
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
```

BEFORE (must match exactly):
```ts
  const root = path.resolve(process.cwd());
```

AFTER:
```ts
  // Resolve from this file, not the cwd: the daemon is launched by systemd from /.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = path.join(root, 'scripts', 'cycle.ts');
  if (!existsSync(entry)) {
    console.error(`FATAL: cycle entry point not found at ${entry}`);
    process.exit(1);
  }
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;
```

## Edit 2 — spawn the real orchestrator and stop on repeated failure

BEFORE (must match exactly):
```ts
      const res = spawnSync('node', [
        '--env-file=.env', 
        '--experimental-strip-types', 
        '--disable-warning=ExperimentalWarning', 
        path.join(root, 'scripts', 'loop-once.ts')
      ], { 
        cwd: root, 
        stdio: 'inherit',
        env: { ...process.env }
      });
      
      if (res.error) {
        console.error('Cycle spawn error:', res.error);
      }
```

AFTER:
```ts
      const res = spawnSync('node', [
        '--env-file=.env',
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        entry,
      ], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env }
      });

      if (res.error || res.status !== 0) {
        consecutiveFailures++;
        console.error(
          `Cycle failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
          res.error ?? `exit code ${res.status}`,
        );
        // Looping forever on a broken system produces one identical error every 5 minutes and
        // no signal. Exit non-zero so systemd/CI surfaces it and restarts deliberately.
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`FATAL: ${MAX_CONSECUTIVE_FAILURES} consecutive cycle failures, exiting.`);
          process.exit(1);
        }
      } else {
        consecutiveFailures = 0;
      }
```

## Also check

`cycle.ts` needs `--env-file=.env` to find `DATABASE_URL`. Verify `runtime/.env` is what the
existing systemd unit relies on, and that `cycle.ts` exits 0 on lock contention (it should — that
is deliberate, and it must **not** count as a failure here):

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "process.exit\|RunLock\|expiresAt" scripts/cycle.ts | head
cat ../docs/hermes-runner.service 2>/dev/null
```

If `cycle.ts` exits non-zero on contention, **STOP** and report it — the failure counter above
would then trip on normal operation.

## Do not

- Do not create `loop-once.ts`. `cycle.ts` is the orchestrator.
- Do not change the 5-minute interval. Cadence is set elsewhere (systemd timer, GitHub
  Actions schedule) and changing it here desynchronises them.
- Do not read or print `.env` contents.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "loop-once" scripts/loop.ts
node --experimental-strip-types --check scripts/loop.ts && echo "SYNTAX OK"
npm test
```

Expected: the first grep returns nothing, `SYNTAX OK`, `# fail 0`.

Do **not** actually start the daemon — it runs forever and needs live database access.
