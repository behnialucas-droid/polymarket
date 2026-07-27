# Cadence & Billing Decision — Foundation v2 §9.2

## Cadence Architecture

Hermes Polybot operates on a **split-cadence architecture** designed around GitHub Actions billing limits and database resource constraints.

### 1. Hourly Execution (`hourly.yml` at `:17 UTC`)
- **Execution Time:** ~25 seconds per run
- **Monthly Billing:** ~30 minutes / month (well within the 2,000 free public GHA minutes)
- **Responsibility:** Runs `cycle.ts` (tracked wallet trade monitoring + PnL updates) followed by `report-hourly.ts` (rules pass + staleness watchdog + Telegram report + rescan due check).

### 2. 30-Day Rescan Generation (`rescan.yml`)
- **Execution Time:** ~3-5 minutes per chunk (self-chaining)
- **Frequency:** Once every 30 days (anchored on `completedAt`)
- **Responsibility:** Re-profiles all 500 wallets from the Polymarket leaderboard, re-classifies them into `copy`, `watch`, or `ignore` tiers, and updates the `memory/` projection.

### 3. Daily Keepalive (`keepalive.yml` at `05:41 UTC`)
- **Responsibility:** Touches `.keepalive` stamp to prevent GitHub from automatically disabling scheduled workflows after 60 days of repository inactivity.

### 4. Fast 5-Minute Cycle (`fast.yml`)
- **Responsibility:** Optional fast cycle for high-frequency paper trading environments. Guarded by `vars.FAST_CYCLES_ENABLED = 'true'`.

## Billing Constraints & Protections

1. **60-Second Execution Boundary:**
   `runtime/` contains exactly ONE production dependency (`postgres ^3.4.5`).
   `npm ci` completes in < 3 seconds. The total job execution time is kept strictly under 55 seconds to round down to 1 billed minute per run.

2. **Lock Lease Protection (`RunLock` Table):**
   Prevents concurrent workflow runs from executing overlapping cycles. If a cycle is already in progress, new runs exit 0 cleanly with `skipped: cycle lock held`.
