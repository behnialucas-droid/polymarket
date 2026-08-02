-- 012_wallet_scoring_epoch.sql — short-term wallet scoring epochs.
--
-- Legacy wallet scores were built from mostly long-term market history, so the
-- copy gate kept trusting wallets whose signals the 24h horizon gate then rejected.
-- An epoch versions the wallet universe: profiles scored under an epoch carry its id,
-- and the pipeline only trusts profiles stamped with the ACTIVE epoch. Old scores stay
-- in place for audit but never gate a copy again. Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS "ScoringEpoch" (
  "id" SERIAL PRIMARY KEY,
  "criteriaJson" TEXT NOT NULL,
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP
);

-- At most one active epoch at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_scoringepoch_active"
  ON "ScoringEpoch" ("active") WHERE "active" = TRUE;

CREATE TABLE IF NOT EXISTS "ScoringEpochAudit" (
  "id" SERIAL PRIMARY KEY,
  "fromEpochId" INTEGER,
  "toEpochId" INTEGER NOT NULL REFERENCES "ScoringEpoch"("id"),
  "trackedBefore" INTEGER NOT NULL,
  "trackedAfter" INTEGER NOT NULL,
  "summaryJson" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Short-term-only wallet metrics. NULL means "not scored under any epoch yet".
ALTER TABLE "WalletProfile"
  ADD COLUMN IF NOT EXISTS "scoringEpoch" INTEGER,
  ADD COLUMN IF NOT EXISTS "shortTermTradeCount" INTEGER,
  ADD COLUMN IF NOT EXISTS "shortTermWinRate" REAL,
  ADD COLUMN IF NOT EXISTS "shortTermPnlPerDollar" REAL,
  ADD COLUMN IF NOT EXISTS "shortTermRecencyWeight" REAL,
  ADD COLUMN IF NOT EXISTS "shortTermCopyScore" REAL,
  ADD COLUMN IF NOT EXISTS "shortTermRank" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_walletprofile_epoch_score"
  ON "WalletProfile" ("scoringEpoch", "shortTermCopyScore" DESC);

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('012', 'Short-term wallet scoring epochs and epoch-gated copy universe')
ON CONFLICT ("version") DO NOTHING;

COMMIT;
