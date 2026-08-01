# 04 — Reliability and operations

Read `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md` plus runtime cycle, rescan, DB, heartbeat, failure, migration, systemd and workflow files before editing.

## Required controls

- One authoritative production topology. Do not combine systemd, GitHub schedules, and browser-triggered Vercel cycles against same database without explicit owner and idempotency.
- Run lock is atomic, owner-bound, renewable, bounded, observable, and recoverable after stale owner. Lease duration must exceed valid cycle or renew during work.
- Migrations have state table, advisory/DB lock, transaction boundaries, idempotency, checksum, backup, compatibility phase, and recovery. Independent ALTER statements must not half-apply silently.
- Raw provider event/fill identity is primary dedup. Hash fallback is explicitly collision-risk and cannot hide real DB errors.
- Pagination, cursors, requested/fetched coverage, late/out-of-order quarantine, retry, and watermark advancement are durable. Partial API success cannot advance watermark as complete.
- Rescan dispatch failure persists failed generation, error, retry count, next attempt, and alert. No generation remains green forever.
- API failures persist source, error, time, affected wallet/market, coverage and last success. Console warning is not evidence.
- Job retries are idempotent. Paper writes have unique decision/event keys.
- Health metrics include API error/freshness, field completeness, snapshot coverage, structured rejection counts, open exposure, stale positions, unresolved settlement and reconciliation.

## Acceptance

Kill/restart tests prove no duplicate cycle writes, no stranded lock, resumable migration, replay completeness, and visible failed run. Tests never call order/signing endpoints.

## Verification

```sh
git diff --check
cd runtime
npm test
```

Database/GitHub/systemd verification requires real access. Missing access is `BLOCKED` with exact output.
