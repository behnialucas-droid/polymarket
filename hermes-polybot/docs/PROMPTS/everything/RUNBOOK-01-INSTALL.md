# RUNBOOK-01 — Install and verify workstation

## Purpose

Bring a clean machine from `git clone` to a verified offline-testable checkout of `hermes-polybot`. No database or network credentials required for this runbook.

## Preconditions

- Git installed; Node.js >= 22.6.0 on PATH (`--experimental-strip-types` is required by every runtime script).
- Read `00-PREFLIGHT.md` first. Expected Git root: `/home/nima/Documents/claude.app/polymarket-repo`.

## Steps

1. Clone and confirm root:

   ```sh
   git clone <repo-url> polymarket-repo
   cd polymarket-repo
   git rev-parse --show-toplevel
   ```

2. Check Node version (must print >= v22.6.0; stop with `BLOCKED` if lower):

   ```sh
   node --version
   ```

3. Install runtime dependencies (exactly one production dependency, `postgres`):

   ```sh
   cd hermes-polybot/runtime
   npm ci
   ```

4. Install dashboard dependencies:

   ```sh
   cd ../dashboard
   npm ci
   ```

5. Create `runtime/.env`. Copy `runtime/.env.example` if it exists; otherwise create the file by hand with these variable NAMES (obtain values from the operator's secret store — never from this pack, never committed):

   ```text
   DATABASE_URL=        # PgBouncer pooled connection
   DIRECT_URL=          # direct Postgres :5432, DDL/migrations
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_CHAT_ID=
   WORKFLOW_DISPATCH_TOKEN=
   DATA_SOURCE=         # polymarket | live | demo (anything else throws)
   ```

   Optional tuning names: `DEMO_NOW_ISO`, `WALLET_SCAN_LIMIT`, `LEADERBOARD_LIMIT`, `PM_MIN_INTERVAL_MS`, `PM_MAX_CONCURRENT`, `CYCLE_ENABLED`, `RESCAN_*`, `REPORT_TZ`, `CYCLE_MAX_AGE_MIN`, `RULES_AUTOUPDATE_ENABLED` (default false — rules frozen during trial).

## Verify

```sh
cd hermes-polybot/runtime
npm test          # pure suites only, no DB required
npm run depcheck  # scripts/assert-one-dep.ts — exactly one dependency: postgres
```

Expected shape:

- `npm test` — all suites pass, `fail 0`. Suites include secrets, safety (GET-only adapters, single Telegram POST), ledger, evidence, settlement, stats.
- `npm run depcheck` — exits 0. Any second production dependency is a failure, not a warning.

Do NOT run `npm run test:db` here; it requires a reachable Postgres (see RUNBOOK-02).

## Failure handling

- `node --version` < 22.6 — install Node 22 (nvm or distro package); do not patch scripts to remove `--experimental-strip-types`.
- `npm ci` lockfile mismatch — do not `npm install` over it silently; report the drift.
- `npm test` failure — stop. Do not proceed to migrations or scheduling with a red offline suite. Record failing suite and output.
- `depcheck` failure — an unexpected dependency was added. Per `00-PREFLIGHT.md`, report file/line; never delete blindly.
