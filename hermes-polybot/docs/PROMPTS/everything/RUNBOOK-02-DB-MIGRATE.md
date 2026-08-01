# RUNBOOK-02 — Database migration

## Purpose

Apply `runtime/db/migrations/*.sql` to Postgres and prove the applied set matches the files on disk. Migrations are additive-only and idempotent.

## Preconditions

- RUNBOOK-01 complete; `runtime/.env` populated (names only in docs; values from secret store).
- Reachable Postgres. `DATABASE_URL` is PgBouncer-pooled (transaction mode: `prepare:false`, no `pg_advisory_lock`). Use `DIRECT_URL` (direct :5432) for DDL if the pooler rejects it.
- A backup taken in this session (step 1). No backup, no migration.

## Steps

1. Backup first (custom format, restorable with `pg_restore`). Uses the env var by name — never paste connection strings:

   ```sh
   cd hermes-polybot/runtime
   set -a; . ./.env; set +a
   pg_dump "$DIRECT_URL" --format=custom \
     --file="backup-$(date -u +%Y%m%dT%H%M%SZ).dump"
   ```

2. Run the migration runner. It executes every `db/migrations/*.sql` in sorted filename order; each file is wrapped in its own transaction and guarded by `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, so reruns are safe:

   ```sh
   npm run migrate
   ```

3. Record the command output and the migration file list:

   ```sh
   ls db/migrations/*.sql
   ```

## Verify

```sh
psql "$DATABASE_URL" -c 'SELECT "version","description" FROM "SchemaMigration" ORDER BY "version";'
```

Expected shape — one row per file present on disk, versions contiguous from `001` up to the highest file present (currently `001`–`008`; if `009_reporting.sql` exists on disk, expect a `009` row too):

```text
 001 | init …
 002 | automation (SchemaMigration/RunLock/Heartbeat/RescanRun)
 003 | short_term
 004 | paper_ledger
 005 | Signed v2 paper ledger with long and short lots
 006 | Decision-time market evidence and immutable journal links
 007 | risk admission (CostModelParams/RiskLimit/AdmissionCheck/SignedPnlSnapshot; seeds cost-v1 + risk-v1)
 008 | Authoritative market resolution evidence for signed settlement
```

Fail the runbook if row versions and `ls db/migrations/*.sql` disagree in either direction. Also spot-check seeds:

```sh
psql "$DATABASE_URL" -c 'SELECT "version" FROM "CostModelParams" UNION ALL SELECT "version" FROM "RiskLimit";'
# expect: cost-v1, risk-v1
```

## Rollback posture

- Additive-only. There are no down migrations. Rolling back means restoring the step-1 backup with `pg_restore`.
- Never hand-edit `SchemaMigration` rows to fake or erase history. A failed file leaves no row (row insert is inside the file's transaction); fix the cause and rerun.
- Never drop tables to "clean up" — raw records and evidence are append-only per pack governance.

## Failure handling

- DNS `EAI_AGAIN` to the pooler host — network-restricted environment; see RUNBOOK-07. Report `BLOCKED`, do not fake success.
- Pooler rejects DDL / prepared statements — rerun the migration with `DATABASE_URL` temporarily set to the `DIRECT_URL` value for this one command; restore afterwards.
- Mid-file SQL error — nothing from that file is applied (transactional). Triage the SQL, fix forward in a NEW numbered migration if schema is wrong; never edit an already-applied file.
- Verification mismatch — stop with `BLOCKED`; the database and repo have diverged and require operator review.
