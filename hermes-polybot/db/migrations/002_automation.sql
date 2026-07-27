-- Migration 002: Automation tables — Foundation v2 Phase 1
-- Additive-only. Idempotent. Safe to run multiple times.
-- Apply via DIRECT_URL (port 5432), never via the pooler.
--
-- Execution order matters:
--   Step 2b (delete duplicate trades) must come AFTER step 2a
--   (repoint DecisionJournal FK), or FK violations will error.

BEGIN;

-- ============================================================
-- Step 0: Schema migration tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS "SchemaMigration" (
  "id"          SERIAL PRIMARY KEY,
  "version"     TEXT NOT NULL UNIQUE,
  "appliedAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "description" TEXT
);

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('002', 'Automation tables: RunLock, RescanRun, Heartbeat, WalletProfile rescan cols, ObservedTrade dedup')
ON CONFLICT ("version") DO NOTHING;

-- ============================================================
-- Step 1: WalletProfile — rescan + classify columns
-- ============================================================
ALTER TABLE "WalletProfile"
  ADD COLUMN IF NOT EXISTS "profileGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "profileAttempts"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "profileError"      TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt"         TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "claimedBy"         TEXT,
  ADD COLUMN IF NOT EXISTS "lastProfiledAt"    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "memoryStatus"      TEXT CHECK ("memoryStatus" IN ('copy','watch','ignore')) DEFAULT 'watch',
  ADD COLUMN IF NOT EXISTS "memoryReason"      TEXT;

-- Index: rescan chunk claim query
-- WHERE profileGeneration < $gen AND profileAttempts < 3 AND (claimedAt IS NULL OR ...)
CREATE INDEX IF NOT EXISTS idx_walletprofile_rescan
  ON "WalletProfile" ("profileGeneration", "profileAttempts", "claimedAt");

-- Index: cycle monitors only tracked wallets (memoryStatus IN ('copy','watch'))
CREATE INDEX IF NOT EXISTS idx_walletprofile_memorystatus
  ON "WalletProfile" ("memoryStatus");

-- ============================================================
-- Step 2a: ObservedTrade — add tradeHash (dedup key)
-- ============================================================
ALTER TABLE "ObservedTrade"
  ADD COLUMN IF NOT EXISTS "tradeHash" TEXT;

-- Populate tradeHash for existing rows using a stable hash of the
-- natural key: walletAddress + marketId + outcome + side + timestamp
-- (conditionId is unreliable — some older rows have NULL)
UPDATE "ObservedTrade"
SET "tradeHash" = encode(
  sha256(("walletAddress" || '|' || "marketId" || '|' || COALESCE("outcome",'') || '|' || COALESCE("side",'') || '|' || "timestamp")::bytea),
  'hex'
)
WHERE "tradeHash" IS NULL;

-- ============================================================
-- Step 2b: Remove duplicate ObservedTrade rows
-- MUST run after step 2a (tradeHash populated).
-- Keeps the lowest-id row for each tradeHash.
-- Re-points DecisionJournal.observedTradeId first to avoid FK violations.
-- ============================================================

-- Repoint DecisionJournal rows that reference a duplicate trade
-- to the canonical (lowest id) version before deleting duplicates.
WITH canonical AS (
  SELECT "tradeHash", MIN("id") AS "keepId"
  FROM "ObservedTrade"
  WHERE "tradeHash" IS NOT NULL
  GROUP BY "tradeHash"
  HAVING count(*) > 1
),
dupes AS (
  SELECT ot."id" AS "dupeId", c."keepId"
  FROM "ObservedTrade" ot
  JOIN canonical c ON ot."tradeHash" = c."tradeHash" AND ot."id" > c."keepId"
)
UPDATE "DecisionJournal" dj
SET "observedTradeId" = d."keepId"
FROM dupes d
WHERE dj."observedTradeId" = d."dupeId";

-- Now safe to delete the duplicates
DELETE FROM "ObservedTrade"
WHERE "id" IN (
  SELECT ot."id"
  FROM "ObservedTrade" ot
  JOIN (
    SELECT "tradeHash", MIN("id") AS "keepId"
    FROM "ObservedTrade"
    WHERE "tradeHash" IS NOT NULL
    GROUP BY "tradeHash"
    HAVING count(*) > 1
  ) c ON ot."tradeHash" = c."tradeHash" AND ot."id" > c."keepId"
);

-- Unique index for ON CONFLICT (tradeHash) DO NOTHING dedup going forward
CREATE UNIQUE INDEX IF NOT EXISTS idx_observedtrade_tradehash
  ON "ObservedTrade" ("tradeHash");

-- Index: per-wallet high-water mark query used by monitorTrades
-- SELECT MAX(timestamp) FROM ObservedTrade WHERE walletAddress = $addr
CREATE INDEX IF NOT EXISTS idx_observedtrade_hwm
  ON "ObservedTrade" ("walletAddress", "timestamp");

-- ============================================================
-- Step 3: DecisionJournal — unique constraint on observedTradeId
-- One decision per observed trade. Partial (NULL observedTradeId is allowed
-- for manual/test entries).
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisionjournal_tradeid_unique
  ON "DecisionJournal" ("observedTradeId")
  WHERE "observedTradeId" IS NOT NULL;

-- ============================================================
-- Step 4: RunLock — row-level cycle lock
-- One row per named lock. The cycle acquires it with
-- SELECT ... FOR UPDATE NOWAIT and releases by deleting the row.
-- Do NOT use pg_advisory_lock — incompatible with pgbouncer transaction pooling.
-- ============================================================
CREATE TABLE IF NOT EXISTS "RunLock" (
  "name"      TEXT PRIMARY KEY,
  "acquiredAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acquiredBy" TEXT,                     -- GITHUB_RUN_ID or local PID
  "expiresAt"  TIMESTAMP                 -- soft TTL; a row older than this is abandoned
);

-- Seed the cycle lock row so SELECT ... FOR UPDATE always finds something
INSERT INTO "RunLock" ("name", "acquiredBy")
VALUES ('cycle', NULL)
ON CONFLICT ("name") DO NOTHING;

-- ============================================================
-- Step 5: RescanRun — 30-day rescan generation ledger
-- ============================================================
CREATE TABLE IF NOT EXISTS "RescanRun" (
  "generation"       INTEGER PRIMARY KEY,
  "status"           TEXT NOT NULL DEFAULT 'running'
                       CHECK ("status" IN ('running','complete','degraded','abandoned')),
  "totalWallets"     INTEGER NOT NULL DEFAULT 0,
  "doneWallets"      INTEGER NOT NULL DEFAULT 0,
  "failedWallets"    INTEGER NOT NULL DEFAULT 0,
  "chunkCount"       INTEGER NOT NULL DEFAULT 0,
  "startedAt"        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"      TIMESTAMP,
  "committedSha"     TEXT,
  "failedAddresses"  JSONB,
  "notes"            TEXT
);

-- Seed generation 0 so isRescanDue() returns true immediately on a fresh DB
-- (lastCompletedAt IS NULL → elapsedDays = infinity → isDue = true)
INSERT INTO "RescanRun" ("generation", "status", "totalWallets", "doneWallets", "completedAt")
VALUES (0, 'complete', 0, 0, now() - interval '31 days')
ON CONFLICT ("generation") DO NOTHING;

-- ============================================================
-- Step 6: Heartbeat — cycle health tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS "Heartbeat" (
  "name"               TEXT PRIMARY KEY,
  "lastRunAt"          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastOkAt"           TIMESTAMP,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastError"          TEXT,
  "metaJson"           TEXT,             -- arbitrary JSON payload per heartbeat
  "updatedAt"          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed the two heartbeat rows so readHeartbeats() always finds them
INSERT INTO "Heartbeat" ("name") VALUES ('cycle')   ON CONFLICT ("name") DO NOTHING;
INSERT INTO "Heartbeat" ("name") VALUES ('rescan')  ON CONFLICT ("name") DO NOTHING;
INSERT INTO "Heartbeat" ("name") VALUES ('hourly')  ON CONFLICT ("name") DO NOTHING;

COMMIT;

-- ============================================================
-- Verification queries (run after applying migration)
-- ============================================================
-- SELECT count(*) FROM "ObservedTrade" WHERE "tradeHash" IS NULL;  -- must be 0
-- SELECT count(*) FROM "RescanRun";                                 -- must be >= 1
-- SELECT * FROM "Heartbeat";                                        -- must have 3 rows
-- SELECT "name" FROM "RunLock";                                     -- must have 'cycle'
-- SELECT "version" FROM "SchemaMigration";                          -- must include '002'
