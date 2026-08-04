-- 011_baseline_reset.sql — Paper trading baseline reset, legacy trade archival,
-- and signed paper account equity reset event type. Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS "PaperBaseline" (
  "id" SERIAL PRIMARY KEY,
  "baselineAt" TIMESTAMP NOT NULL,
  "equityUsd" NUMERIC(28, 12) NOT NULL,
  "reason" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_paperbaseline_active"
  ON "PaperBaseline" ("active") WHERE "active" = TRUE;

CREATE TABLE IF NOT EXISTS "PaperTradeArchive" (
  "id" INTEGER PRIMARY KEY,
  "decisionJournalId" INTEGER,
  "walletAddress" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "outcome" TEXT,
  "side" TEXT,
  "entryPrice" REAL NOT NULL,
  "currentPrice" REAL,
  "simulatedPositionSize" REAL NOT NULL,
  "unrealizedPnl" REAL DEFAULT 0,
  "realizedPnl" REAL,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "isDemo" INTEGER NOT NULL DEFAULT 0,
  "openedAt" TIMESTAMP,
  "closedAt" TIMESTAMP,
  "resolvedAt" TIMESTAMP,
  "archivedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archiveReason" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "PnlSnapshotArchive" (
  "id" INTEGER PRIMARY KEY,
  "paperTradeId" INTEGER NOT NULL,
  "price" REAL NOT NULL,
  "pnl" REAL NOT NULL,
  "collectedAt" TIMESTAMP NOT NULL,
  "archivedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archiveReason" TEXT NOT NULL
);

-- Allow BASELINE_RESET in SignedPaperLedgerEntry eventType check constraint
ALTER TABLE "SignedPaperLedgerEntry"
  DROP CONSTRAINT IF EXISTS "SignedPaperLedgerEntry_eventType_check";

ALTER TABLE "SignedPaperLedgerEntry"
  ADD CONSTRAINT "SignedPaperLedgerEntry_eventType_check"
  CHECK ("eventType" IN (
    'OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT',
    'COLLATERAL_RESERVE', 'COLLATERAL_RELEASE', 'MARK', 'SETTLE', 'CORRECTION', 'REJECTED_ACTION', 'BASELINE_RESET'
  ));

ALTER TABLE "SignedPaperLedgerEntry"
  ALTER COLUMN "paperStrategyActionId" DROP NOT NULL;

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('011', 'Baseline cutoff, legacy paper trade archive, and equity reset ledger event')
ON CONFLICT ("version") DO NOTHING;

COMMIT;
