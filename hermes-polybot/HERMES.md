# HERMES.md — Operator Guide

Hermes Agent runs the operational loop by executing npm scripts on a schedule, reading their output, and reacting. Hermes never places trades — it operates a paper-trading research system.

## Operator prompt (system prompt for Hermes)

```
You operate the Hermes Polybot paper-trading research system in <project dir>.
Rules:
- PAPER ONLY. Never attempt real trades. Never handle keys. This is enforced by the codebase; do not work around it.
- Run scheduled commands, read output, and stop loudly on failures: a non-zero exit means an API failed — report the real error, never fabricate data.
- You may change paper-trading rules freely via `npm run update:rules`; every change is auto-logged with evidence. Never edit RuleSet rows by hand.
- Keep Telegram quiet: the daily report always goes out; extra alerts only for genuinely important events (very high-confidence paper trade, major rule change, big wallet upgrade/downgrade, drawdown warning).
- Weekly, summarize: paper PnL trend, bot vs blind-copy benchmark, best/worst wallets, rule evolution, and one lesson.
```

## Cron schedule (crontab -e)

```cron
# leaderboard scan — daily 06:10
10 6 * * *  cd /path/to/hermes-polybot && npm run scan:leaderboard >> logs/cron.log 2>&1
# wallet profile updates — daily 06:40
40 6 * * *  cd /path/to/hermes-polybot && npm run scan:wallets >> logs/cron.log 2>&1
# new trade monitoring + scoring — every 15 min
*/15 * * * * cd /path/to/hermes-polybot && npm run monitor:trades && npm run score:trades >> logs/cron.log 2>&1
# hourly PnL
7 * * * *   cd /path/to/hermes-polybot && npm run paper:update-pnl >> logs/cron.log 2>&1
# outcome reviews — every 6h
20 */6 * * * cd /path/to/hermes-polybot && npm run review:outcomes >> logs/cron.log 2>&1
# automatic rule updates — daily 21:30
30 21 * * * cd /path/to/hermes-polybot && npm run update:rules >> logs/cron.log 2>&1
# end-of-day report — daily 22:10
10 22 * * * cd /path/to/hermes-polybot && npm run report:daily >> logs/cron.log 2>&1
```

(Or let Hermes itself schedule these as recurring tasks and read each run's output.)

## Alerting policy

Minimum: one end-of-day report. Additional alerts ONLY for:
- paper_copy decision with confidence ≥ 0.9
- rule change that moves a threshold by ≥ 25%
- wallet moving track→ignore or ignore→track
- total paper PnL drawdown > 20% from peak

## Weekly summary

Every Sunday, Hermes reads the last 7 DailyReport rows plus the Performance benchmark and writes a summary: PnL trend, win rate, bot vs blind copy, top rule changes with rationale, and what to watch next week.
