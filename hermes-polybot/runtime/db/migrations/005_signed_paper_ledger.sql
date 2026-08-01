-- 005_signed_paper_ledger.sql — additive v2, short-capable paper ledger.
-- Legacy PaperTrade/PaperPosition remain immutable historical models.

BEGIN;

CREATE TABLE IF NOT EXISTS "PaperInstrument" (
  "id" SERIAL PRIMARY KEY,
  "conditionId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("conditionId", "assetId", "outcome")
);

CREATE TABLE IF NOT EXISTS "PaperStrategyAction" (
  "id" SERIAL PRIMARY KEY,
  "paperAccountId" INTEGER NOT NULL REFERENCES "PaperAccount"("id"),
  "decisionJournalId" INTEGER NOT NULL REFERENCES "DecisionJournal"("id"),
  "sourceObservedTradeId" INTEGER NOT NULL REFERENCES "ObservedTrade"("id"),
  "paperInstrumentId" INTEGER NOT NULL REFERENCES "PaperInstrument"("id"),
  "actionType" TEXT NOT NULL CHECK ("actionType" IN (
    'OPEN_LONG', 'OPEN_SHORT', 'INCREASE_LONG', 'INCREASE_SHORT',
    'REDUCE_LONG', 'REDUCE_SHORT', 'FLATTEN', 'REJECT'
  )),
  "requestedShares" NUMERIC(28, 12) NOT NULL CHECK ("requestedShares" > 0),
  "executionPrice" NUMERIC(20, 12) CHECK ("executionPrice" IS NULL OR ("executionPrice" > 0 AND "executionPrice" < 1)),
  "entryFees" NUMERIC(28, 12) NOT NULL DEFAULT 0 CHECK ("entryFees" >= 0),
  "collateralBuffer" NUMERIC(28, 12) NOT NULL DEFAULT 0 CHECK ("collateralBuffer" >= 0),
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "reason" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "SignedPaperPosition" (
  "id" SERIAL PRIMARY KEY,
  "paperAccountId" INTEGER NOT NULL REFERENCES "PaperAccount"("id"),
  "paperInstrumentId" INTEGER NOT NULL REFERENCES "PaperInstrument"("id"),
  "netShares" NUMERIC(28, 12) NOT NULL DEFAULT 0,
  "longShares" NUMERIC(28, 12) NOT NULL DEFAULT 0 CHECK ("longShares" >= 0),
  "shortShares" NUMERIC(28, 12) NOT NULL DEFAULT 0 CHECK ("shortShares" >= 0),
  "reservedCollateral" NUMERIC(28, 12) NOT NULL DEFAULT 0 CHECK ("reservedCollateral" >= 0),
  "realizedPnl" NUMERIC(28, 12) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'flat', 'awaiting_settlement', 'resolved', 'invalidated')),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("paperAccountId", "paperInstrumentId"),
  CHECK ("netShares" = "longShares" - "shortShares"),
  CHECK (
    ("status" = 'flat' AND "longShares" = 0 AND "shortShares" = 0)
    OR ("status" <> 'flat')
  )
);

CREATE TABLE IF NOT EXISTS "SignedPaperLot" (
  "id" SERIAL PRIMARY KEY,
  "signedPaperPositionId" INTEGER NOT NULL REFERENCES "SignedPaperPosition"("id"),
  "paperStrategyActionId" INTEGER NOT NULL REFERENCES "PaperStrategyAction"("id"),
  "direction" TEXT NOT NULL CHECK ("direction" IN ('LONG', 'SHORT')),
  "openedShares" NUMERIC(28, 12) NOT NULL CHECK ("openedShares" > 0),
  "remainingShares" NUMERIC(28, 12) NOT NULL CHECK ("remainingShares" >= 0 AND "remainingShares" <= "openedShares"),
  "entryPrice" NUMERIC(20, 12) NOT NULL CHECK ("entryPrice" > 0 AND "entryPrice" < 1),
  "entryFees" NUMERIC(28, 12) NOT NULL DEFAULT 0 CHECK ("entryFees" >= 0),
  "reservedCollateral" NUMERIC(28, 12) NOT NULL CHECK ("reservedCollateral" >= 0),
  "openedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "SignedPaperLedgerEntry" (
  "id" SERIAL PRIMARY KEY,
  "paperAccountId" INTEGER NOT NULL REFERENCES "PaperAccount"("id"),
  "signedPaperPositionId" INTEGER REFERENCES "SignedPaperPosition"("id"),
  "paperStrategyActionId" INTEGER NOT NULL REFERENCES "PaperStrategyAction"("id"),
  "eventType" TEXT NOT NULL CHECK ("eventType" IN (
    'OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT',
    'COLLATERAL_RESERVE', 'COLLATERAL_RELEASE', 'MARK', 'SETTLE', 'CORRECTION', 'REJECTED_ACTION'
  )),
  "quantityShares" NUMERIC(28, 12) NOT NULL DEFAULT 0 CHECK ("quantityShares" >= 0),
  "price" NUMERIC(20, 12) CHECK ("price" IS NULL OR ("price" >= 0 AND "price" <= 1)),
  "collateralDelta" NUMERIC(28, 12) NOT NULL DEFAULT 0,
  "realizedPnlDelta" NUMERIC(28, 12) NOT NULL DEFAULT 0,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_signedposition_account_instrument"
  ON "SignedPaperPosition" ("paperAccountId", "paperInstrumentId");
CREATE INDEX IF NOT EXISTS "idx_signedlot_position_open"
  ON "SignedPaperLot" ("signedPaperPositionId", "openedAt")
  WHERE "remainingShares" > 0;
CREATE INDEX IF NOT EXISTS "idx_signedledger_position_created"
  ON "SignedPaperLedgerEntry" ("signedPaperPositionId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_signedaction_account_created"
  ON "PaperStrategyAction" ("paperAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_signedaction_decision"
  ON "PaperStrategyAction" ("decisionJournalId");
CREATE INDEX IF NOT EXISTS "idx_signedlot_action"
  ON "SignedPaperLot" ("paperStrategyActionId");
CREATE INDEX IF NOT EXISTS "idx_signedledger_account_created"
  ON "SignedPaperLedgerEntry" ("paperAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_signedledger_action"
  ON "SignedPaperLedgerEntry" ("paperStrategyActionId");

CREATE OR REPLACE FUNCTION "reject_signed_ledger_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Signed paper ledger is append-only; write a correction entry instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "signed_ledger_append_only" ON "SignedPaperLedgerEntry";
CREATE TRIGGER "signed_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "SignedPaperLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "reject_signed_ledger_mutation"();

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('005', 'Signed v2 paper ledger with long and short lots')
ON CONFLICT ("version") DO NOTHING;

COMMIT;
