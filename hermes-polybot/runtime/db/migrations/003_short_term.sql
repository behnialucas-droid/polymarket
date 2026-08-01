-- 003_short_term.sql — short-term horizon filter
--
-- Two additions, both idempotent:
--   WalletProfile.shortTermShare  fraction of 30d trades committed for <= the ceiling
--   MarketSnapshot.endDate        ABSOLUTE resolution deadline
--
-- endDate matters because "timeToResolution" is computed at fetch time: a stored value
-- silently decays, so a snapshot claiming "20h to resolution" may be hours stale. The
-- absolute deadline never rots and is what audit queries should join on.

ALTER TABLE "WalletProfile"
  ADD COLUMN IF NOT EXISTS "shortTermShare" REAL;

ALTER TABLE "MarketSnapshot"
  ADD COLUMN IF NOT EXISTS "endDate" TEXT;

-- Decision-time horizon, so a later rule update can bucket outcomes by how much
-- runway a copy had, the same way it already buckets by spread and liquidity.
ALTER TABLE "DecisionJournal"
  ADD COLUMN IF NOT EXISTS "horizonScore" REAL;

CREATE INDEX IF NOT EXISTS "idx_walletprofile_shortterm"
  ON "WalletProfile" ("shortTermShare");
