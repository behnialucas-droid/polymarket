# Prompt Pack — Index

Each card is one self-contained task. Load `00-SYSTEM.md` as the system prompt, then paste
exactly one card as the user message. One card per session. Do not batch.

Cards are ordered by dependency and by damage-if-left-alone. Work top to bottom.

| # | Card | Fixes | Depends on | Why it matters |
|---|------|-------|-----------|----------------|
| 01 | `TASK-01-missing-await.md` | Two scripts operate on Promises instead of values | — | `update-rules` never applies changes; `report-daily` sends the literal string `undefined` to Telegram |
| 02 | `TASK-02-classify-scale.md` | `classify()` compares a 0..1 score against `>= 70` | — | `memoryStatus` can never become `copy`, so the whole `memory/` projection is fed by a dead branch |
| 03 | `TASK-03-classify-real-inputs.md` | Drawdown and inactivity are hardcoded at the call site | 02 | Two of five classification gates are decorative |
| 04 | `TASK-04-fail-loud.md` | Five `catch {}` blocks swallow real API errors | — | Violates the project's stated contract; a truncated leaderboard is recorded as fact |
| 05 | `TASK-05-copyscore-math.md` | `roiScore * 0` and a `(1 - Σweights)` term that is always 0 | — | ROI is computed, stored, and discarded; the copy threshold is effectively mis-scaled |
| 06 | `TASK-06-market-category.md` | Category is taken from a per-day-unique event slug | — | Category edge never matches, so `categoryFitScore` is permanently 0.5 |
| 07 | `TASK-07-rule-ratchet.md` | Auto-rules only tighten, and re-read all history every run | 05 | Thresholds ratchet toward zero signals and never recover |
| 08 | `TASK-08-outcome-timepoints.md` | 1h/6h/24h prices read by array index, not timestamp | — | Outcome reviews silently mislabel price points whenever a snapshot is missed |
| 09 | `TASK-09-benchmark-watchlist.md` | Watchlist losers are never counted as avoided | — | Benchmarks are biased in favour of blind copying |
| 10 | `TASK-10-mirror-guard.md` | Nothing prevents `runtime/` and `dashboard/` drifting | — | `rules.ts` already drifted once and shipped two different rule sets |
| 11 | `TASK-11-loop-script.md` | `loop.ts` spawns a file that does not exist in this tree | — | The daemon entry point is dead |
| 12 | `TASK-12-side-default.md` | A malformed trade row silently becomes a BUY | — | Fabricated data, which the safety contract forbids |
| 13 | `TASK-13-dead-rule-key.md` | `minResolvedTrades` is declared but never read | — | A rule that looks active and is not |
| 14 | `TASK-14-best-category.md` | `bestCategory` can be the least-bad losing category | 06 | A losing category earns a +0.3 thesis bonus |

## Already done — do not redo

The short-term horizon filter is **complete**. `runtime/src/lib/engine/horizon.ts` exists and
is wired into trade scoring, wallet scoring, `classify`, the pipeline, migration
`003_short_term.sql`, and `tests/horizon.test.ts`. If a card seems to ask you to re-add it,
you are reading the wrong card.

## Running verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
npm test          # offline suites — must stay green after every card
npm run test:db   # needs live DATABASE_URL; EAI_AGAIN offline is environmental
```
