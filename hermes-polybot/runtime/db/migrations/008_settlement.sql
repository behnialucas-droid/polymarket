-- 008_settlement.sql — authoritative market resolution evidence.
-- Marks are telemetry; ONLY a confirmed evidence row may finalize a position.

BEGIN;

CREATE TABLE IF NOT EXISTS "MarketResolutionEvidence" (
  "id" SERIAL PRIMARY KEY,
  "marketId" TEXT NOT NULL,
  "conditionId" TEXT NOT NULL,
  "resolvedOutcome" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('proposed', 'confirmed', 'invalidated')),
  "resolutionSource" TEXT NOT NULL,
  "observedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawJson" TEXT NOT NULL DEFAULT '{}',
  CHECK (("status" <> 'confirmed' OR "resolvedOutcome" IS NOT NULL) IS TRUE)
);

-- Exactly one TERMINAL evidence row (confirmed or invalidated) per condition.
-- A single partial index over both statuses makes contradictory terminal
-- states (confirmed AND invalidated) impossible at the database level; a
-- genuine dispute correction requires an explicit future CORRECTION migration.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_resolution_terminal_unique"
  ON "MarketResolutionEvidence" ("conditionId") WHERE "status" IN ('confirmed', 'invalidated');
CREATE INDEX IF NOT EXISTS "idx_resolution_condition_status"
  ON "MarketResolutionEvidence" ("conditionId", "status");

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('008', 'Authoritative market resolution evidence for signed settlement')
ON CONFLICT ("version") DO NOTHING;

COMMIT;
