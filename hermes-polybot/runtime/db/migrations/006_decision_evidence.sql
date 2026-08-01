-- 006_decision_evidence.sql — immutable decision-time market evidence.
-- Legacy rows remain evidenceVersion 0 and are not reinterpreted.

BEGIN;

ALTER TABLE "MarketSnapshot"
  ADD COLUMN IF NOT EXISTS "quoteCollectedAt" TIMESTAMPTZ;

ALTER TABLE "DecisionJournal"
  ADD COLUMN IF NOT EXISTS "marketSnapshotId" INTEGER REFERENCES "MarketSnapshot"("id"),
  ADD COLUMN IF NOT EXISTS "decisionAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "evidenceVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "evidenceStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "quoteCollectedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "snapshotAgeMs" BIGINT,
  ADD COLUMN IF NOT EXISTS "maxSnapshotAgeMs" BIGINT;

ALTER TABLE "DecisionJournal"
  DROP CONSTRAINT IF EXISTS "decisionjournal_evidence_v1_validity";

ALTER TABLE "DecisionJournal"
  ADD CONSTRAINT "decisionjournal_evidence_v1_validity" CHECK ((
    "evidenceVersion" = 0
    OR (
      "evidenceVersion" = 1
      AND "decisionAt" IS NOT NULL
      AND "evidenceStatus" IN ('VALID', 'MISSING_SNAPSHOT', 'STALE_SNAPSHOT', 'FUTURE_SNAPSHOT')
      AND "maxSnapshotAgeMs" IS NOT NULL
      AND "maxSnapshotAgeMs" >= 0
      AND (
        (
          "evidenceStatus" = 'VALID'
          AND "marketSnapshotId" IS NOT NULL
          AND "quoteCollectedAt" IS NOT NULL
          AND "quoteCollectedAt" <= "decisionAt"
          AND "snapshotAgeMs" IS NOT NULL
          AND "snapshotAgeMs" >= 0
          AND "snapshotAgeMs" <= "maxSnapshotAgeMs"
        )
        OR (
          "evidenceStatus" = 'MISSING_SNAPSHOT'
          AND "marketSnapshotId" IS NULL
          AND "quoteCollectedAt" IS NULL
          AND "snapshotAgeMs" IS NULL
        )
        OR (
          "evidenceStatus" = 'STALE_SNAPSHOT'
          AND "marketSnapshotId" IS NOT NULL
          AND "quoteCollectedAt" IS NOT NULL
          AND "quoteCollectedAt" <= "decisionAt"
          AND "snapshotAgeMs" IS NOT NULL
          AND "snapshotAgeMs" > "maxSnapshotAgeMs"
        )
        OR (
          "evidenceStatus" = 'FUTURE_SNAPSHOT'
          AND "marketSnapshotId" IS NOT NULL
          AND "quoteCollectedAt" IS NOT NULL
          AND "quoteCollectedAt" > "decisionAt"
          AND "snapshotAgeMs" IS NOT NULL
          AND "snapshotAgeMs" < 0
        )
      )
    )
  ) IS TRUE);

CREATE INDEX IF NOT EXISTS "idx_marketsnapshot_market_quote_collected"
  ON "MarketSnapshot" ("marketId", "quoteCollectedAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_decisionjournal_market_snapshot"
  ON "DecisionJournal" ("marketSnapshotId");

CREATE OR REPLACE FUNCTION "reject_journaled_market_snapshot_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "DecisionJournal"
    WHERE "marketSnapshotId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'Market snapshot is immutable after use as decision evidence';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "market_snapshot_journaled_immutable" ON "MarketSnapshot";
CREATE TRIGGER "market_snapshot_journaled_immutable"
  BEFORE UPDATE OR DELETE ON "MarketSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "reject_journaled_market_snapshot_mutation"();

INSERT INTO "SchemaMigration" ("version", "description")
VALUES ('006', 'Decision-time market evidence and immutable journal links')
ON CONFLICT ("version") DO NOTHING;

COMMIT;
