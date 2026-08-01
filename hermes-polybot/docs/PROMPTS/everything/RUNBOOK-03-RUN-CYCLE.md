# RUNBOOK-03 — Run a cycle (demo replay and live)

## Purpose

Execute one full pipeline cycle — demo replay for deterministic verification, live for production — and prove the pipeline invariants with SQL evidence.

## Preconditions

- RUNBOOK-01 and RUNBOOK-02 complete (migrations applied, offline tests green).
- Demo replay needs no external network: the demo adapter reads `runtime/fixtures/demo/` (`leaderboard.json`, `wallets/<addr>.json`, `markets/<id>.json` with timeline) and fails loud with `AdapterError` on any missing/malformed fixture — it never invents data.

## Step 0 — database-free dry-run (no PostgreSQL required)

Before any database work, prove the full decision chain offline. This prints
every stage (evidence -> score -> admission -> signed action -> settlement math)
and persists nothing:

```sh
cd hermes-polybot/runtime
DATA_SOURCE=demo \
DEMO_NOW_ISO=2026-08-01T00:00:00Z \
DEMO_SETTLE_NOW_ISO=2026-08-02T12:00:00Z \
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/demo-dry-run.ts
```

Expected: historical expired markets skip with fail-closed horizon reasons; a
source BUY opens `OPEN_LONG`; a source SELL opens `OPEN_SHORT` with inverse
binary collateral; the unresolved market prints `stays awaiting settlement`.

## Steps — demo replay (deterministic, two-step clock)

```sh
cd hermes-polybot/runtime
export DATA_SOURCE=demo
export DEMO_NOW_ISO=2026-08-01T00:00:00Z
# 1. Seed wallet profiles first — cycle scoring requires profiles to exist:
node --experimental-strip-types scripts/scan-leaderboard.ts
node --experimental-strip-types scripts/scan-wallets.ts
# 2. Day-1 cycle:
npm run cycle
# 3. Advance the deterministic clock one day and rerun:
export DEMO_NOW_ISO=2026-08-02T00:00:00Z
npm run cycle
```

The fixtures deliberately exercise: a source `SELL` (must journal as `OPEN_SHORT`), a NO-outcome `BUY`, one confirmed resolution (source `uma`), and one market left unresolved — awaiting settlement is NOT a loss and must stay `awaiting_settlement`.

## Steps — live

```sh
cd hermes-polybot/runtime
export DATA_SOURCE=polymarket   # or live; any other value throws
npm run cycle && npm run report
```

## Reading the cycle log line

```text
observed:N scored:N copied:N pnl:N marked:N resolved:N evidence:N settled:N timing:Nms
```

observed = new `ObservedTrade` rows ingested; scored = trades journaled into `DecisionJournal`; copied = `paper_copy` decisions; pnl = legacy PnL snapshots updated; marked = signed positions marked; resolved = resolution evidence observations; evidence = decision-time snapshot evidence written; settled = positions finalized from confirmed evidence. `skipped: CYCLE_ENABLED is false` means the kill switch is on, not a failure.

## Verify — invariant SQL (all via `psql "$DATABASE_URL"`)

```sql
-- 1. v1 decision evidence: VALID rows carry a snapshot no newer than the decision;
--    everything else is a structured skip. Expect: statuses only in the four values, and 0 violations.
SELECT "evidenceStatus", COUNT(*) FROM "DecisionJournal" WHERE "evidenceVersion" = 1 GROUP BY 1;
SELECT COUNT(*) AS violations FROM "DecisionJournal"
WHERE "evidenceVersion" = 1 AND "evidenceStatus" = 'VALID'
  AND ("marketSnapshotId" IS NULL OR "quoteCollectedAt" IS NULL OR "quoteCollectedAt" > "decisionAt");

-- 2. Every paper_copy decision has an AdmissionCheck row. Expect 0.
SELECT COUNT(*) AS missing_admission FROM "DecisionJournal" d
LEFT JOIN "AdmissionCheck" a ON a."decisionJournalId" = d."id"
WHERE d."decision" = 'paper_copy' AND a."id" IS NULL;

-- 3. Admitted checks produced action + lot + ledger entry in the same journal transaction. Expect 0 and 0.
SELECT COUNT(*) AS admitted_without_action FROM "AdmissionCheck" a
LEFT JOIN "PaperStrategyAction" p ON p."decisionJournalId" = a."decisionJournalId"
WHERE a."admitted" = 1 AND p."id" IS NULL;
SELECT COUNT(*) AS actions_incomplete FROM "PaperStrategyAction" p
LEFT JOIN "SignedPaperLot" l ON l."paperStrategyActionId" = p."id"
LEFT JOIN "SignedPaperLedgerEntry" e ON e."paperStrategyActionId" = p."id"
WHERE p."actionType" <> 'REJECT' AND (l."id" IS NULL OR e."id" IS NULL);

-- 4. Source SELL maps to shorts only — never legacy SELL_CLOSE. Expect only OPEN_SHORT / INCREASE_SHORT.
SELECT p."actionType", COUNT(*) FROM "PaperStrategyAction" p
JOIN "ObservedTrade" o ON o."id" = p."sourceObservedTradeId"
WHERE UPPER(o."side") = 'SELL' GROUP BY 1;

-- 5. Settlement only from confirmed MarketResolutionEvidence. Expect 0.
SELECT COUNT(*) AS settle_without_confirmed FROM "SignedPaperLedgerEntry" e
JOIN "SignedPaperPosition" sp ON sp."id" = e."signedPaperPositionId"
JOIN "PaperInstrument" i ON i."id" = sp."paperInstrumentId"
LEFT JOIN "MarketResolutionEvidence" r
  ON r."conditionId" = i."conditionId" AND r."status" = 'confirmed'
WHERE e."eventType" = 'SETTLE' AND r."id" IS NULL;

-- 6. Ledger is append-only (trigger). Expect ERROR, then roll back.
BEGIN;
UPDATE "SignedPaperLedgerEntry" SET "metadataJson" = "metadataJson"
WHERE "id" = (SELECT MIN("id") FROM "SignedPaperLedgerEntry");
ROLLBACK;
-- expected: ERROR: Signed paper ledger is append-only; write a correction entry instead
```

For the demo replay additionally confirm the unresolved market is still `awaiting_settlement` (not settled, not a loss):

```sql
SELECT "status", COUNT(*) FROM "SignedPaperPosition" GROUP BY 1;
```

## Failure handling

- `AdapterError: demo fixture missing/malformed …` — fixture path or JSON broken; fix fixtures, do not stub data.
- `Unsupported DATA_SOURCE` — typo in env; only `polymarket`, `live`, `demo` are legal.
- Any invariant query nonzero / wrong shape — stop. That is a contract breach per `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md`; record the offending rows, do not delete them.
- DB unreachable — `BLOCKED` (RUNBOOK-07); never report an unverified cycle as passed.
