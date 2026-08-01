# 07 — Release, rollback, and incident response

Normative data/accounting changes reference `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md`. No deployment is live-trading authorization.

## Release gates

Before deployment:

```sh
git diff --check
cd runtime && npm test
npm run mirror
npx tsc --noEmit
```

Inspect changed-file allowlist, migration checksum/state, dependency diff, secret/paper-only scan, dashboard build, accounting model, cost model, and trial-version compatibility. No commit, push, migration, or deployment without explicit operator request.

## Migration release

1. Backup database and record backup ID.
2. Run additive migration in empty and representative staging copies.
3. Check schema invariants, constraints, indexes, row counts and raw-data preservation.
4. Backfill only with labeled provenance; never overwrite raw evidence.
5. Run old/new application compatibility and reconciliation tests.
6. Apply under migration lock and verify state/checksum.
7. Start exactly one worker owner.
8. Monitor coverage, failures, locks, exposure, settlement and reconciliation.

## Rollback and correction

Prefer forward-fix. Never destructive rollback production without explicit confirmation and verified backup. If deployment fails: stop worker, preserve logs/raw evidence, mark run failed, restore dashboard last known good, and do not delete decisions. For data errors append correction record, original ID, reason, actor/run and affected decision count.

## Incident triggers

- unauthorized HTTP method, signing, order, key or dependency;
- future snapshot used by decision/benchmark;
- PnL/equity reconciliation failure;
- missing settlement provenance or unresolved settled as loss;
- unsupported SELL simulated;
- stale open exposure beyond horizon;
- lock/lease collision or migration partial failure;
- API/pagination/coverage breach;
- cost or portfolio-limit inputs missing;
- dashboard presents failed query as zero success.

## Required incident output

UTC timeline, run/trial ID, rule/cohort/accounting/cost versions, affected decisions, paper exposure, source errors, containment, recovery, correction provenance, regression test, and trial validity. Never claim real-market loss/profit from paper records.
