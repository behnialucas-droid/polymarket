# RUNBOOK-06 — Telegram reporting channel

## Purpose

Create the report bot, discover the chat id, wire both env NAMES, and verify delivery. Telegram is the single outbound mutation the system performs (one POST to the Bot API); everything sent passes `redact()`.

## Preconditions

- A Telegram account with access to the target chat/group.
- RUNBOOK-01 complete. `runtime/src/lib/telegram.ts` requires both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; with either missing, reporting is skipped — the cycle still runs.

## Steps

1. Create the bot: message `@BotFather` → `/newbot` → follow prompts. BotFather returns the bot token. Store it in the secret store under the NAME `TELEGRAM_BOT_TOKEN`. Do not paste it into files, logs, tickets, or this pack.

2. Discover the chat id: send any message to the bot (or add it to the group and post), then:

   ```sh
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
     | grep -o '"chat":{"id":[-0-9]*' | head -1
   ```

   Run with the env var exported from the secret store — the command references the NAME, never a literal. Group ids are negative numbers. Store under `TELEGRAM_CHAT_ID`.

3. Set both names in every runtime environment that reports: `runtime/.env` (local/systemd) and GitHub Actions secrets (RUNBOOK-05 step 1).

## Verify

```sh
cd hermes-polybot/runtime
npm run report        # scripts/report-hourly.ts — sends the hourly report
```

Expected: a report message arrives in the target chat; process exits 0. Then confirm redaction and safety posture:

```sh
npm test              # includes tests/secrets.test.ts and tests/safety.test.ts
```

Safety suite enforces: data adapters are GET-only; the ONLY outbound POST in the runtime is the single Telegram send; all outbound text is routed through `redact()`.

## Redaction policy — hard rules

- Never echo `TELEGRAM_BOT_TOKEN` or any secret value in shell output, logs, commits, or reports. Refer to env NAMES only.
- All report text passes `redact()` before send (`telegram.ts`); do not add send paths that bypass it.
- If a token value ever appears anywhere (log, chat, workflow output), treat it as burned: rotate per `docs/00-ROTATE-SECRETS.md`, then update the stored secret NAME's value everywhere.

## Failure handling

- HTTP 401/404 from Bot API — token wrong or revoked; re-issue via BotFather, update secret store.
- HTTP 400 `chat not found` — wrong `TELEGRAM_CHAT_ID`, or the bot was never started/added in that chat; redo step 2.
- HTTP 429 (rate limited) — Telegram throttling; the sender splits long messages, but bursts can still 429. Retry later; do not tighten the loop.
- Timeout / network error — report failure is logged and the run continues. Reports must NEVER block or fail the cycle: cycle and report are separate steps (`npm run cycle && npm run report`, separate `ExecStart`/`ExecStartPost` in systemd). If a report error ever aborts ingestion, that is a bug — file it, do not work around it by disabling reporting silently.
- No message but exit 0 — check both names are set in the environment that actually ran (GHA secrets vs local `.env` are separate stores).
