# RUNBOOK-05 — Scheduler ownership (GitHub Actions or systemd)

## Purpose

Configure exactly one scheduler owner for the cycle. GitHub Actions is the current production owner; systemd is the offline/self-hosted alternative. Running both double-fires the pipeline and fights over the `RunLock` lease.

## Preconditions

- RUNBOOK-02 and RUNBOOK-03 verified (migrations applied, one manual cycle green).
- Workflows live at REPO ROOT `.github/workflows/`: `fast.yml` (cron `*/15 * * * *`, cycle+report), `hourly.yml` (cron `17 * * * *`), `rescan.yml` (workflow_dispatch), `ci.yml` (npm test on push/PR to master), `hermes-keepalive.yml` (daily, defeats the 60-day auto-disable).
- `gh` CLI authenticated for the repo.

## Steps — GitHub Actions (production owner)

1. Set the five repository secrets by NAME (values from secret store; never echo them):

   ```sh
   gh secret set DATABASE_URL
   gh secret set DIRECT_URL
   gh secret set TELEGRAM_BOT_TOKEN
   gh secret set TELEGRAM_CHAT_ID
   gh secret set WORKFLOW_DISPATCH_TOKEN
   ```

   Each command prompts on stdin — do not pass values as arguments (shell history).

2. Enable the workflows:

   ```sh
   gh workflow enable fast.yml
   gh workflow enable hourly.yml
   gh workflow enable rescan.yml
   gh workflow enable hermes-keepalive.yml
   ```

3. Smoke test with one manual dispatch:

   ```sh
   gh workflow run hourly.yml
   gh run watch          # or: gh run list --workflow=hourly.yml -L 1
   ```

4. Enforce single ownership — disable the systemd timer if present:

   ```sh
   sudo systemctl disable --now hermes-runner.timer
   sudo systemctl status hermes-runner.timer   # expect inactive/disabled
   ```

## Steps — systemd alternative (only if GHA is NOT the owner)

```sh
sudo cp hermes-polybot/docs/hermes-runner.service /etc/systemd/system/
sudo cp hermes-polybot/docs/hermes-runner.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-runner.timer   # 15-min cadence; unit reads runtime/.env
# Then disable the GHA schedulers:
gh workflow disable fast.yml
gh workflow disable hourly.yml
```

The unit runs `scripts/cycle.ts` then `scripts/report-hourly.ts` from `runtime/` with `runtime/.env`.

## Verify

```sh
gh run list -L 5                                   # GHA owner: recent green runs
sudo systemctl list-timers | grep hermes || true   # must be empty when GHA owns
psql "$DATABASE_URL" -c 'SELECT "name","lastRunAt","lastOkAt","consecutiveFailures" FROM "Heartbeat";'
```

Expected: `cycle` heartbeat `lastOkAt` advances every ~15 min from exactly one source; `consecutiveFailures` = 0. `RunLock.acquiredBy` shows a `GITHUB_RUN_ID` (GHA) or local PID (systemd) — never an alternating mix.

## Failure handling

- Both owners active (heartbeats advancing faster than cadence, alternating `acquiredBy`) — disable one immediately with the commands above; document the owner per `05-DASHBOARD-DEPLOY.md` topology rule.
- Dispatch smoke run fails on secrets — re-set the missing NAME; workflow logs must never print values (they are masked; if a value appears, rotate it per `docs/00-ROTATE-SECRETS.md`).
- Schedules silently stop after ~60 days — GHA auto-disable; `hermes-keepalive.yml` prevents it. See RUNBOOK-07.
- `CYCLE_ENABLED=false` — cycle logs `skipped`; that is the kill switch working, not a scheduler fault.
