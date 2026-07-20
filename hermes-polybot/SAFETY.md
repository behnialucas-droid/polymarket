# SAFETY.md

## Why version one is paper trading only

Copy trading looks easy and loses money easily. Leaderboards select for survivors and outliers, not repeatable edge. Before any real dollar moves, the strategy must prove — with resolved-market evidence — that bot-filtered copying beats blind copying *after* spreads, slippage, and late entries. That is exactly what this system measures. Until the paper record proves an edge over a meaningful sample, real execution is not just disabled, it is unimplemented.

## Why real execution is disabled

Not a feature flag — the capability does not exist in the codebase:

- No order-placement endpoints are referenced anywhere (enforced by a test).
- Adapters make GET requests only (enforced by a test). The single POST in the codebase is the optional Telegram report.
- No signing libraries, no wallet objects, no `privateKey`/`signTransaction` code (enforced by a test).
- Paper position sizes are capped $5–$20 by code *and* a database CHECK constraint.

## How autonomy could be added later

Only after paper trading proves the edge, and in stages: (1) longer paper burn-in with live data; (2) a separate, isolated execution service with its own keys, spending caps, and kill switch — never keys inside this app; (3) tiny real sizes with the paper system running in parallel as the control group. Each stage should require explicit human sign-off. The bot may change its own *paper* rules autonomously; it should never grant itself execution.

## Risks this system watches for (and you should too)

- **Stale data**: prices move between wallet entry and detection. The price-move gate skips trades that ran away; if an API fails, commands stop with the real error rather than acting on old numbers.
- **Low liquidity**: a leaderboard whale can enter a market you cannot. The liquidity gate and copyability score exist because an uncopyable win is not an edge.
- **Wide spreads**: crossing a wide spread taxes every trade; spread-heavy losers automatically tighten the spread threshold.
- **Copy trading generally**: you always enter later and exit dumber than the wallet you copy. The benchmark page exists to prove whether following is worth anything at all.
- **Misleading leaderboards**: one lucky YOLO ranks above a steady grinder. The one-hit-wonder penalty, resolved-trade minimums, and consistency damping fight exactly this.

## Why private keys should never be stored in the app

A key in this app would turn a research tool into a hot wallet attached to a web dashboard, scripts, logs, and an LLM operator — maximum attack surface, zero need. Nothing here requires signing. Log redaction additionally scrubs anything private-key-shaped as defense in depth. If execution is ever built, keys belong in a separate hardened signer with caps, not here.
