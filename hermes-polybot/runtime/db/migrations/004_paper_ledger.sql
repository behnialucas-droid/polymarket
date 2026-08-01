-- 004_paper_ledger.sql — additive, paper-only independent position ledger.
-- Legacy PaperTrade rows remain historical evidence and are never reinterpreted.

BEGIN;

ALTER TABLE "ObservedTrade"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'polymarket',
  ADD COLUMN IF NOT EXISTS "providerEventId" TEXT,
  ADD COLUMN IF NOT EXISTS "transactionHash" TEXT,
  ADD COLUMN IF NOT EXISTS "assetId" TEXT,
  ADD COLUMN IF NOT EXISTS "outcomeIndex" INTEGER,
  ADD COLUMN IF NOT EXISTS "quantityShares" REAL,
  ADD COLUMN IF NOT EXISTS "notionalUsd" REAL,
  ADD COLUMN IF NOT EXISTS "observedAt" TEXT,
  ADD COLUMN IF NOT EXISTS "ingestedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_observedtrade_provider_event"
  ON "ObservedTrade" ("source", "providerEventId")
  WHERE "providerEventId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "PaperAccount" (
  "id" SERIAL PRIMARY KEY,
  "strategyKey" TEXT NOT NULL,
  "isDemo" INTEGER NOT NULL DEFAULT 0,
  "mode" TEXT NOT NULL DEFAULT 'paper' CHECK ("mode" = 'paper'),
  "baseCurrency" TEXT NOT NULL DEFAULT 'USDC',
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'paused')),
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("strategyKey", "isDemo")
);

CREATE TABLE IF NOT EXISTS "PaperPosition" (
  "id" SERIAL PRIMARY KEY,
  "paperAccountId" INTEGER NOT NULL REFERENCES "PaperAccount"("id"),
  "marketId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "quantityShares" REAL NOT NULL DEFAULT 0 CHECK ("quantityShares" >= 0),
  "averageEntryPrice" REAL,
  "costBasis" REAL NOT NULL DEFAULT 0 CHECK ("costBasis" >= 0),
  "realizedPnl" REAL NOT NULL DEFAULT 0,
  "unrealizedPnl" REAL NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'closed', 'awaiting_settlement', 'resolved')),
  "version" INTEGER NOT NULL DEFAULT 0,
  "openedAt" TIMESTAMP,
  "closedAt" TIMESTAMP,
  "resolvedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("paperAccountId", "marketId", "outcome")
);

CREATE TABLE IF NOT EXISTS "PaperPositionLot" (
  "id" SERIAL PRIMARY KEY,
  "paperPositionId" INTEGER NOT NULL REFERENCES "PaperPosition"("id"),
  "sourceDecisionJournalId" INTEGER REFERENCES "DecisionJournal"("id"),
  "openedShares" REAL NOT NULL CHECK ("openedShares" > 0),
  "remainingShares" REAL NOT NULL CHECK ("remainingShares" >= 0 AND "remainingShares" <= "openedShares"),
  "entryPrice" REAL NOT NULL CHECK ("entryPrice" > 0 AND "entryPrice" < 1),
  "costBasis" REAL NOT NULL CHECK ("costBasis" >= 0),
  "openedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "PaperLedgerEntry" (
  "id" SERIAL PRIMARY KEY,
  "paperAccountId" INTEGER NOT NULL REFERENCES "PaperAccount"("id"),
  "paperPositionId" INTEGER REFERENCES "PaperPosition"("id"),
  "eventType" TEXT NOT NULL CHECK ("eventType" IN ('BUY_OPEN', 'BUY_INCREASE', 'SELL_CLOSE', 'SELL_NO_POSITION', 'RESOLVE', 'CORRECTION')),
  "sourceObservedTradeId" INTEGER REFERENCES "ObservedTrade"("id"),
  "sourceDecisionJournalId" INTEGER REFERENCES "DecisionJournal"("id"),
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "quantityShares" REAL NOT NULL DEFAULT 0 CHECK ("quantityShares" >= 0),
  "price" REAL,
  "costBasisDelta" REAL NOT NULL DEFAULT 0,
  "realizedPnlDelta" REAL NOT NULL DEFAULT 0,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "DecisionJournal"
  ADD COLUMN IF NOT EXISTS "paperAction" TEXT,
  ADD COLUMN IF NOT EXISTS "paperActionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "paperPositionId" INTEGER REFERENCES "PaperPosition"("id");

CREATE INDEX IF NOT EXISTS "idx_paperposition_account_market"
  ON "PaperPosition" ("paperAccountId", "marketId", "outcome");
CREATE INDEX IF NOT EXISTS "idx_paperlot_position_open"
  ON "PaperPositionLot" ("paperPositionId", "openedAt")
  WHERE "remainingShares" > 0;
CREATE INDEX IF NOT EXISTS "idx_paperledger_position"
  ON "PaperLedgerEntry" ("paperPositionId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_paperledger_observed"
  ON "PaperLedgerEntry" ("sourceObservedTradeId");

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('004', 'Independent paper account position lots and append-only ledger')
ON CONFLICT ("version") DO NOTHING;

COMMIT;
