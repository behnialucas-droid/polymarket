-- 009_reporting.sql — report run identity and delivery evidence.
-- One ReportRun per (kind, periodKey); every Telegram attempt is recorded.

BEGIN;

CREATE TABLE IF NOT EXISTS "ReportRun" (
  "id" SERIAL PRIMARY KEY,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('hourly', 'daily', 'trial')),
  "periodKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'started' CHECK ("status" IN ('started', 'sent', 'failed', 'skipped')),
  "contentHash" TEXT,
  "startedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP,
  UNIQUE ("kind", "periodKey")
);

CREATE TABLE IF NOT EXISTS "ReportDelivery" (
  "id" SERIAL PRIMARY KEY,
  "reportRunId" INTEGER NOT NULL REFERENCES "ReportRun"("id"),
  "channel" TEXT NOT NULL DEFAULT 'telegram',
  "attempt" INTEGER NOT NULL CHECK ("attempt" >= 1),
  "status" TEXT NOT NULL CHECK ("status" IN ('sent', 'failed')),
  "error" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_reportdelivery_run" ON "ReportDelivery" ("reportRunId");

-- Report lock rows for the RunLock lease pattern (same as the cycle lock).
INSERT INTO "RunLock" ("name", "acquiredBy") VALUES ('report-hourly', NULL) ON CONFLICT ("name") DO NOTHING;
INSERT INTO "RunLock" ("name", "acquiredBy") VALUES ('report-daily', NULL) ON CONFLICT ("name") DO NOTHING;

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('009', 'Report run identity, delivery evidence, report locks')
ON CONFLICT ("version") DO NOTHING;

COMMIT;
