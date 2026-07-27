# Hermes Polybot — Memory Index

Generation 0001 · complete · 810/810 profiled · 0 failed
Window: trailing 30 days · Rendered from Postgres, do not hand-edit.

## What this is
Derived state. Postgres is the source of truth. Any manual edit here is
overwritten on the next publish and has no effect on the running system.

## Roster summary
| status | count | meaning |
|---|---|---|
| copy   |   0 | monitored every cycle; signals become paper positions |
| watch  | 810 | monitored every cycle; signals recorded, not traded |
| ignore |   0 | not monitored; re-evaluated next generation |

## Top by score (copy tier)
| # | address | score | trades30d | pnl30d | consistency | since |
|---|---|---|---|---|---|---|

## Files
- `roster.csv` — every wallet, one row
- `wallets/copy/` — detail for copy tier
- `wallets/watch/` — detail for watch tier
- `generation.json` — machine-readable stamp
- `STATUS.md` — live health

## For agents
Read this file first. Read `roster.csv` second if you need all 500.
Read individual wallet files only when asked about a specific address.
Never read all of `wallets/` at once.
