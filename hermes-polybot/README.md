# Hermes Polybot — Polymarket Copy-Trading Research System

**Paper trading only. Not financial advice.**

## What it does

- Scans the Polymarket leaderboard (top 500 wallets, 30-day lookback).
- Scores each wallet by ROI, consistency, copyability, category edge, liquidity quality, entry timing — with a one-hit-wonder penalty.
- Tracks the best wallets, detects their new trades, and scores each trade against versioned rule thresholds.
- **Paper trades** copy candidates with simulated $5–$20 positions. Updates PnL hourly. Reviews outcomes when markets resolve.
- Benchmarks the bot-filtered strategy against blind leaderboard copying; tracks missed winners and avoided losers.
- **Self-improves**: automatically adjusts rule thresholds based on outcome evidence — every change versioned and explained.
- Sends end-of-day reports (optionally via Telegram) and shows everything in a Next.js dashboard.

## What it does NOT do

- It does **not** place real trades. There is no order code, no signing code, no wallet code.
- It does **not** ask for, store, or touch private keys. Ever.
- It does **not** spend money. All positions are simulated numbers in SQLite.
- It does **not** fake live data. If an API fails you see the real error and the command exits non-zero.

Safety details: see [SAFETY.md](SAFETY.md). Operator guide: see [HERMES.md](HERMES.md).

## Setup

Requires Node.js >= 22.13 (uses built-in `node:sqlite` and TypeScript type-stripping — no ORM binary, no build step for scripts).

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run seed          # loads clearly-labeled DEMO data
npm run dev           # dashboard at http://localhost:3000
```

> Note: the original spec suggested Prisma or Drizzle. This build uses raw SQL migrations over the Node built-in SQLite driver instead (built in an offline environment where those packages were unavailable). The schema matches the spec's models exactly; swapping in Drizzle later only requires re-declaring the schema.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `DATA_SOURCE` | `demo` (labeled synthetic data) or `live` (public Polymarket APIs) | `live` |
| `DATABASE_PATH` | SQLite file location | `./data/polybot.db` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional daily-report delivery; token is redacted from all logs | unset (report prints to stdout) |
| `LEADERBOARD_LIMIT` | wallets per leaderboard scan | 500 |
| `WALLET_SCAN_LIMIT` | wallets profiled per scan run | 50 |

## Commands

```bash
npm run dev                # dashboard
npm run db:migrate         # apply SQL migrations
npm run seed               # demo data (isDemo=1 on every row, DEMO banner in UI)
npm run scan:leaderboard   # pull top wallets
npm run scan:wallets       # profile + score wallets (30d activity)
npm run monitor:trades     # detect new trades from tracked wallets
npm run score:trades       # score trades -> paper_copy / watchlist / skip (+ opens paper trades)
npm run paper:update-pnl   # hourly PnL snapshot for open paper trades
npm run review:outcomes    # resolve finished markets, judge decisions, record lessons
npm run update:rules       # automatic rule updates (versioned, evidence-logged)
npm run report:daily       # end-of-day report (Telegram if configured)
npm run test               # full test suite
```

## How it works

- **Leaderboard scan** (`scan:leaderboard`): pulls ranked wallets from Polymarket's public data API into `WalletProfile` rows plus a `LeaderboardScan` audit record.
- **Wallet scoring** (`scan:wallets`): fetches each wallet's 30-day trades and their markets. `src/lib/engine/walletScoring.ts` computes ROI, win rate, consistency (win rate damped by PnL variance), copyability (liquidity + spread + entry timing), category strengths, and a one-hit-wonder penalty (share of profit from single best trade; extra penalty for few resolved trades). Status thresholds decide track / watch / ignore — reason stored.
- **Trade scoring** (`score:trades`): each new observed trade is scored against the *active rule set*. Hard gates (liquidity, spread, price-move-since-entry, wallet score, time-to-resolution, already-resolved) force `skip`; otherwise the weighted score picks `paper_copy` / `watchlist` / `skip`. Everything lands in `DecisionJournal` with per-factor scores, reasons, risks.
- **Paper trading**: every `paper_copy` opens a `PaperTrade` sized $5–$20 by confidence (bounds enforced in code *and* by a DB CHECK constraint). `paper:update-pnl` snapshots hourly PnL; `review:outcomes` settles winners at $1 / losers at $0, writes `OutcomeReview` with lessons and judges the original decision good/bad.
- **Self-improvement** (`update:rules`): with ≥5 resolved paper trades, underperforming buckets (wide-spread, low-liquidity, late-entry) tighten the corresponding thresholds; consistently losing wallets get auto-downgraded. Every change creates a new `RuleSet` version plus a `RuleChange` row with reason, evidence summary, before/after JSON, and expected improvement. No approval is needed because only paper-trading rules change.
- **Benchmarks**: `Performance` page compares bot-filtered PnL vs a blind $10-flat copy of every observed trade, plus hypothetical watchlist/skip buckets, missed winners, and avoided losers.

## Reading the dashboard

Three questions, answered top-left first:

1. **Are we profitable on paper?** — Overview: total paper PnL, win rate, PnL chart.
2. **Which wallets are worth copying?** — Wallet Rankings (status + reason), Wallet Profile pages.
3. **What did the bot learn today?** — Rules (auto-changes with evidence), Reports (end-of-day summary), Decision Journal (good/bad judgments).

A yellow **DEMO DATA** badge appears whenever demo rows exist in the database.

## Deploying to Vercel

The dashboard builds and deploys on Vercel as-is (`next build` passes). One honest limitation: **Vercel's filesystem is ephemeral — a SQLite file will not persist there.** Options:

1. **Recommended for v1**: run the whole system (scripts + dashboard) on a machine you control (local, VPS, Raspberry Pi). This is where the Hermes cron loop lives anyway.
2. Deploy the dashboard to Vercel in demo mode (`DATA_SOURCE=demo` + run seed at build) purely as a UI preview — it will be labeled DEMO.
3. Later: point the data layer at a hosted libSQL/Turso database and set `DATABASE_PATH` accordingly (requires swapping `node:sqlite` for `@libsql/client` in `src/lib/db.ts` — the only file that touches the driver).

## Adding to Max HQ

The dashboard is a standard Next.js app with a compact, dark, self-contained layout — embed it in Max HQ as an iframe pointing at the deployed URL, or mount the pages into an existing Next app (all pages live under `app/`, all data access under `src/lib/`).

## How Hermes operates it

See [HERMES.md](HERMES.md) for the operator prompt, the cron schedule, and alerting rules.
