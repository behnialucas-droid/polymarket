-- 007_risk_admission.sql — versioned risk limits, cost model, admission evidence,
-- and signed-position mark snapshots. Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS "CostModelParams" (
  "id" SERIAL PRIMARY KEY,
  "version" TEXT NOT NULL UNIQUE,
  "paramsJson" TEXT NOT NULL,
  "active" INTEGER NOT NULL DEFAULT 0 CHECK ("active" IN (0, 1)),
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_costmodel_single_active"
  ON "CostModelParams" ("active") WHERE "active" = 1;

CREATE TABLE IF NOT EXISTS "RiskLimit" (
  "id" SERIAL PRIMARY KEY,
  "version" TEXT NOT NULL UNIQUE,
  "limitsJson" TEXT NOT NULL,
  "active" INTEGER NOT NULL DEFAULT 0 CHECK ("active" IN (0, 1)),
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_risklimit_single_active"
  ON "RiskLimit" ("active") WHERE "active" = 1;

CREATE TABLE IF NOT EXISTS "AdmissionCheck" (
  "id" SERIAL PRIMARY KEY,
  "paperAccountId" INTEGER NOT NULL REFERENCES "PaperAccount"("id"),
  "decisionJournalId" INTEGER NOT NULL REFERENCES "DecisionJournal"("id"),
  "observedTradeId" INTEGER NOT NULL REFERENCES "ObservedTrade"("id"),
  "admitted" INTEGER NOT NULL CHECK ("admitted" IN (0, 1)),
  "rejectionsJson" TEXT NOT NULL DEFAULT '[]',
  "costJson" TEXT NOT NULL DEFAULT '{}',
  "sizedShares" NUMERIC(28, 12) CHECK (("sizedShares" IS NULL OR "sizedShares" >= 0) IS TRUE),
  "requiredCollateral" NUMERIC(28, 12) CHECK (("requiredCollateral" IS NULL OR "requiredCollateral" >= 0) IS TRUE),
  "costModelVersion" TEXT NOT NULL,
  "riskLimitVersion" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("admitted" = 0 OR ("sizedShares" IS NOT NULL AND "requiredCollateral" IS NOT NULL)) IS TRUE)
);
CREATE INDEX IF NOT EXISTS "idx_admission_decision" ON "AdmissionCheck" ("decisionJournalId");
CREATE INDEX IF NOT EXISTS "idx_admission_account_created" ON "AdmissionCheck" ("paperAccountId", "createdAt");

CREATE TABLE IF NOT EXISTS "SignedPnlSnapshot" (
  "id" SERIAL PRIMARY KEY,
  "signedPaperPositionId" INTEGER NOT NULL REFERENCES "SignedPaperPosition"("id"),
  "markPrice" NUMERIC(20, 12) NOT NULL CHECK ("markPrice" >= 0 AND "markPrice" <= 1),
  "unrealizedPnl" NUMERIC(28, 12) NOT NULL,
  "quoteCollectedAt" TIMESTAMPTZ,
  "collectedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_signedpnl_position_time"
  ON "SignedPnlSnapshot" ("signedPaperPositionId", "collectedAt");

ALTER TABLE "PaperAccount"
  ADD COLUMN IF NOT EXISTS "startingCash" NUMERIC(28, 12) NOT NULL DEFAULT 1000
  CHECK ("startingCash" >= 0);

-- Seed v1 model assumptions. These are DOCUMENTED ASSUMPTIONS, not measurements;
-- the trial's scenario matrix varies them for sensitivity analysis.
INSERT INTO "CostModelParams" ("version", "paramsJson", "active")
VALUES (
  'cost-v1',
  '{"version":"cost-v1","feeBps":20,"halfSpreadFloorBps":50,"impactCoeff":80,"impactExponent":0.5,"latencyMs":4000,"latencyDriftBpsPerSec":2,"maxFillFraction":0.05}',
  1
)
ON CONFLICT ("version") DO NOTHING;

INSERT INTO "RiskLimit" ("version", "limitsJson", "active")
VALUES (
  'risk-v1',
  '{"version":"risk-v1","maxGrossExposureUsd":400,"maxNetExposureUsd":300,"maxPerInstrumentUsd":40,"maxPerWalletUsd":120,"maxPerCategoryUsd":250,"maxDailyTurnoverUsd":300,"maxConcurrentPositions":25,"maxQuoteAgeMs":60000,"maxSpread":0.08,"minLiquidity":1000,"maxHorizonHours":24,"shortBufferPerShare":0.02}',
  1
)
ON CONFLICT ("version") DO NOTHING;

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('007', 'Risk limits, cost model, admission evidence, signed marks')
ON CONFLICT ("version") DO NOTHING;

COMMIT;
