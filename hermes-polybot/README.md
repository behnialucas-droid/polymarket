# Hermes Polybot

> **24/7 Operation**: The bot cycle and hourly reports run fully on GitHub Actions — your laptop does NOT need to be on. The dashboard web UI can be made persistent via systemd (see [24/7 Dashboard](#247-dashboard-setup)). — Polymarket Copy-Trading Research System

**Paper trading only. Not financial advice.**

## What it does

- Scans the Polymarket leaderboard (top 500 wallets, 30-day lookback).
- Scores each wallet by ROI, consistency, copyability, category edge, liquidity quality, entry timing — with a one-hit-wonder penalty.
- Tracks the best wallets, detects their new trades, and scores each trade against versioned rule thresholds.
- **Paper trades** copy candidates with simulated $5–$20 positions. Updates PnL hourly. Reviews outcomes when markets resolve.
- Benchmarks the bot-filtered strategy against blind leaderboard copying; tracks missed winners and avoided losers.
- **Self-improves**: automatically adjusts rule thresholds based on outcome evidence — every change versioned and explained.
- Sends hourly Telegram reports. Shows everything in a Next.js dashboard.

## What it does NOT do

- It does **not** place real trades. There is no order code, no signing code, no wallet code.
- It does **not** ask for, store, or touch private keys. Ever.
- It does **not** spend money. All positions are simulated numbers in Postgres.
- It does **not** fake live data. If an API fails you see the real error and the job exits non-zero.

Safety details: see [SAFETY.md](SAFETY.md). Operator guide: see [HERMES.md](HERMES.md).

## Infrastructure

The automation runs entirely on **GitHub Actions** (scheduled workflows). The Next.js
dashboard is a separate package that can be deployed to Vercel or any Node host.

State lives in **Supabase (PostgreSQL)**. Git holds only code and a derived
`memory/` directory — never state, never credentials.

## Setup — Dashboard (local dev)

Requires Node.js >= 22.6.

```bash
cd dashboard
npm install
cp ../.env.example .env
npm run dev           # dashboard at http://localhost:4000
```

## Setup — Automation (GitHub Actions)

1. Fork or clone this repo.
2. In GitHub → Settings → Secrets, add (see `.env.example` for descriptions):
   - `DATABASE_URL` — Supabase transaction pooler URL (port 6543, pgbouncer=true)
   - `DIRECT_URL` — Supabase direct connection URL (port 5432, for migrations)
   - `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather
   - `TELEGRAM_CHAT_ID` — Chat ID to receive reports
   - `WORKFLOW_DISPATCH_TOKEN` — Fine-grained PAT with `Actions: read+write`
3. Enable workflows in the Actions tab.
4. Manually trigger `hourly.yml` to verify.

See [docs/00-ROTATE-SECRETS.md](docs/00-ROTATE-SECRETS.md) for credential rotation instructions.

## Environment variables

| Variable | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | Supabase transaction pooler (port 6543) | ✅ |
| `DIRECT_URL` | Supabase direct connection (port 5432, migrations) | ✅ |
| `TELEGRAM_BOT_TOKEN` | Bot token for hourly reports | ✅ |
| `TELEGRAM_CHAT_ID` | Chat ID to deliver reports to | ✅ |
| `WORKFLOW_DISPATCH_TOKEN` | Fine-grained PAT for rescan dispatch | ✅ |
| `LEADERBOARD_LIMIT` | Wallets per leaderboard scan | 500 |
| `WALLET_SCAN_LIMIT` | Wallets profiled per cycle | 20 |
| `DATA_SOURCE` | `live` or `demo` | `live` |
| `REPORT_TZ` | Timezone for Telegram report timestamps | `UTC` |

## Workflows

| Workflow | Schedule | Purpose |
|---|---|---|
| `hourly.yml` | Every hour at :17 | Cycle + Telegram report + rescan due-check |
| `rescan.yml` | Dispatch only | 30-day wallet rescan (chunked, self-chaining) |
| `keepalive.yml` | Daily at 05:41 UTC | Empty commit to prevent 60-day auto-disable |
| `ci.yml` | Push / PR | Tests + credential scan + dependency guard |

## How it works

- **Leaderboard scan**: pulls ranked wallets from Polymarket's public data API.
- **Wallet scoring**: `src/lib/engine/walletScoring.ts` computes ROI, consistency, copyability.
- **Trade scoring**: each new trade scored against the active rule set → `paper_copy` / `watchlist` / `skip`.
- **Paper trading**: `paper_copy` decisions open a `PaperPosition` sized $5–$20 by confidence.
- **Self-improvement**: underperforming rule thresholds tighten automatically, every change versioned.
- **Git-as-memory**: after each 30-day rescan, wallet classifications are committed to `memory/` as a deterministic, read-only projection of the database.

## Reading the dashboard

1. **Are we profitable on paper?** — Overview: total paper PnL, win rate, PnL chart.
2. **Which wallets are worth copying?** — Wallet Rankings (status + reason), Wallet Profile pages.
3. **What did the bot learn today?** — Rules (auto-changes with evidence), Decision Journal.

See [HERMES.md](HERMES.md) for the full operator guide.

## 24/7 Dashboard Setup

The bot **cycle + Telegram reports** run entirely on GitHub Actions — no laptop required.

The **dashboard web UI** (Next.js at `localhost:4000`) is a local process. To keep it alive after reboots, install it as a systemd service:

```bash
# 1. Copy the service file
sudo cp docs/hermes-dashboard.service /etc/systemd/system/hermes-dashboard.service

# 2. Enable and start
sudo systemctl daemon-reload
sudo systemctl enable hermes-dashboard
sudo systemctl start hermes-dashboard

# 3. Check status
sudo systemctl status hermes-dashboard
```

Logs: `sudo journalctl -u hermes-dashboard -f`

To stop: `sudo systemctl stop hermes-dashboard`

> The `.service` file is at [`docs/hermes-dashboard.service`](docs/hermes-dashboard.service).
> Edit `WorkingDirectory` and `User` if your paths differ.
