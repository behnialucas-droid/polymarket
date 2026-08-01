-- Migration 010: Index DecisionJournal(observedTradeId) for efficient unscored trade batching
CREATE INDEX IF NOT EXISTS "idx_decisionjournal_observed_trade" ON "DecisionJournal" ("observedTradeId");
