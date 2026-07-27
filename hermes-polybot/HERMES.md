# Hermes Polybot — Operator Guide

## What is this?

Hermes is a **Polymarket copy-trading research system**. It tracks top wallets,
paper-trades their signals, and reports results hourly via Telegram. All positions
are simulated — no real money moves.

## How it runs

Everything runs on **GitHub Actions** in the `behnialucas-droid/polymarket` repository.
There is no local crontab, no daemon, no server to keep alive.

| Workflow | Schedule | What it does |
|---|---|---|
| `hourly.yml` | Every hour at :17 UTC | Incremental cycle + Telegram report + watchdog |
| `rescan.yml` | Dispatched by hourly | 30-day wallet rescan (self-chaining chunks) |
| `keepalive.yml` | Daily at 05:41 UTC | Empty commit to prevent 60-day auto-disable |
| `ci.yml` | On push / PR | Tests + credential scan + dependency guard |

## Reading the Telegram report

**Healthy:**
```
Hermes 27/07/2026, 17:17 (UTC)
gen 7 · copy 38 · watch 87

new trades (1h): 14
open positions: 9  (+412.80)
realized 24h: +1284.05

rules: v4 · 3 triggered
rescan: next in 22.3 d
all systems nominal
```

**Degraded (something failed):**
```
DEGRADED
  - heartbeat 'cycle' has not succeeded for 183 min
  - hourly failed 3x in a row: Network error ...

Hermes 27/07/2026, 20:17 (UTC)
...
```
Problems are always **line one**. Nobody scrolls.

## Watching the system

1. **Telegram**: hourly report with health status
2. **GitHub Actions**: green/red on each run — URL in the report when failed
3. **Dashboard**: `https://your-vercel-url/` — live Postgres-backed UI

## Configuration (GitHub Variables)

Set these in GitHub → Settings → Variables:

| Variable | Default | Notes |
|---|---|---|
| `CYCLE_ENABLED` | `true` | Set to `false` to pause trading |
| `RESCAN_ENABLED` | `true` | Set to `false` to skip rescan due-checks |
| `RESCAN_INTERVAL_DAYS` | `30` | Days between full wallet rescans |
| `LEADERBOARD_LIMIT` | `500` | Wallets per leaderboard pull |
| `WALLET_SCAN_LIMIT` | `20` | Wallets profiled per hourly cycle |
| `REPORT_TZ` | `UTC` | Timezone for report timestamps |
| `PM_MIN_INTERVAL_MS` | `200` | Min ms between Polymarket API calls |
| `PM_MAX_CONCURRENT` | `5` | Max concurrent API requests |
| `MIN_HOURS_TO_RESOLUTION` | `4` | Minimum hours-to-resolution for copy signals |

## Credentials (GitHub Secrets)

See [docs/00-ROTATE-SECRETS.md](docs/00-ROTATE-SECRETS.md) for the rotation runbook.

| Secret | Description |
|---|---|
| `DATABASE_URL` | Supabase transaction pooler (port 6543) |
| `DIRECT_URL` | Supabase direct connection (port 5432) |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID for hourly reports |
| `WORKFLOW_DISPATCH_TOKEN` | Fine-grained PAT for rescan self-chaining |

## Wallet memory

After each 30-day rescan, wallet classifications are committed to `memory/`:

```
memory/
  INDEX.md          # ≤ 150 lines — always-in-context summary
  STATUS.md         # live health
  roster.csv        # all 500 wallets, one line each
  generation.json   # machine-readable stamp
  wallets/
    copy/           # detail files for copy-tier wallets
    watch/          # detail files for watch-tier wallets
  history/          # diff vs previous generation
```

`memory/` is a **write-only projection** of Postgres. Nothing reads it back.
Editing it manually has no effect — it is overwritten on the next rescan.

## Full build spec

See `docs/` for the Foundation v2 runbook and phase-by-phase definitions of done.
