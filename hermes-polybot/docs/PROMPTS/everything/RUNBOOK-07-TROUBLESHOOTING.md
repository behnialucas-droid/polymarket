# RUNBOOK-07 — Troubleshooting

## Purpose

Triage table for the known failure modes. Every entry ends in a fix or an honest `BLOCKED` — never a fabricated pass.

## DNS `EAI_AGAIN` to the Supabase pooler

Symptom: `getaddrinfo EAI_AGAIN <pooler-host>` on any DB command. Cause: sandboxed/restricted network cannot resolve the pooler hostname.

```sh
getent hosts $(node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)')
```

No result → the environment is network-blocked. Report `BLOCKED` with the command output. Do not switch to fabricated data; do not mark DB checks passed. Rerun from a network-capable host (GHA runner qualifies).

## PgBouncer constraints (transaction pooling)

- Prepared statements are not supported → the `postgres` client must run with `prepare:false` against `DATABASE_URL`. Symptom otherwise: `prepared statement "…" does not exist`.
- `pg_advisory_lock` is forbidden (session state) → concurrency uses the `RunLock` row lease instead. Never reintroduce advisory locks.
- DDL/migrations may be rejected by the pooler → run them via `DIRECT_URL` (RUNBOOK-02).

## RunLock lease stuck

Symptom: every cycle exits immediately with a lock-held message; no work done.

```sql
SELECT "name","acquiredAt","acquiredBy","expiresAt" FROM "RunLock" WHERE "name" = 'cycle';
```

- `expiresAt` in the past → abandoned lease; safe to clear:

  ```sql
  UPDATE "RunLock" SET "acquiredBy" = NULL, "expiresAt" = NULL
  WHERE "name" = 'cycle' AND "expiresAt" < now();
  ```

- `expiresAt` in the future → a holder may be live (`acquiredBy` is a `GITHUB_RUN_ID` or local PID). Confirm the run/process is dead before clearing; clearing a live lease double-runs the cycle.

## Stale Heartbeat rows

```sql
SELECT "name","lastRunAt","lastOkAt","consecutiveFailures","lastError" FROM "Heartbeat";
```

`cycle.lastOkAt` older than `CYCLE_MAX_AGE_MIN` (default 150 min) means the scheduler owner is not firing: check RUNBOOK-05 verify block (GHA runs list / systemd timers). Nonzero `consecutiveFailures` → read `lastError` first; it is the actual exception text.

## GitHub Actions 60-day auto-disable

GHA disables cron workflows in repos without pushes for ~60 days. `hermes-keepalive.yml` (daily 05:41 UTC) exists to prevent this. If schedules stopped silently:

```sh
gh workflow list                     # look for "disabled_inactivity"
gh workflow enable fast.yml && gh workflow enable hourly.yml && gh workflow enable hermes-keepalive.yml
```

## Demo fixture `AdapterError` meanings

The demo adapter fails loud; each message states the exact defect:

- `demo fixture missing: <path>` — expected file absent under `runtime/fixtures/demo/`.
- `demo fixture malformed: <path>: …` — invalid JSON.
- `DEMO_NOW_ISO is not a valid ISO timestamp` — fix the env value (e.g. `2026-08-01T00:00:00Z`).
- `demo leaderboard.json must be an array` / `entry N has no address` — leaderboard shape wrong.
- `demo wallet address contains unsafe characters` — address fails the safe-id pattern (path-traversal guard).

Fix the fixture; never patch the adapter to tolerate bad data.

## Migration failure triage

- Each `db/migrations/*.sql` file is one transaction: a failure applies nothing from that file and writes no `SchemaMigration` row. Fix cause, rerun `npm run migrate` (idempotent).
- Applied-file drift (row exists but file edited) — forbidden; write a new numbered migration instead.
- Pooler DDL rejection → `DIRECT_URL` (above). Permission denied → role lacks DDL; use the owner role for migrations only.
- Never hand-insert or delete `SchemaMigration` rows to make verification pass.

## Escalation

Anything not covered: capture command, full output, `git rev-parse HEAD`, and heartbeat/lock state; report `BLOCKED` per `08-UPDATE-PROTOCOL.md`. Do not tune rules, thresholds, or contracts to make a failure disappear.
