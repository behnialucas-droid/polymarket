// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
export const MAX_DECISION_SNAPSHOT_AGE_MS = 60_000;

export type EvidenceStatus = 'VALID' | 'MISSING_SNAPSHOT' | 'STALE_SNAPSHOT' | 'FUTURE_SNAPSHOT';

export interface DecisionSnapshotEvidence {
  id: number;
  marketId: string;
  quoteCollectedAt: string | Date | null;
}

export interface DecisionEvidence {
  status: EvidenceStatus;
  marketSnapshotId: number | null;
  decisionAt: Date;
  quoteCollectedAt: Date | null;
  snapshotAgeMs: number | null;
  maxSnapshotAgeMs: number;
  reason: string;
}

function asValidDate(value: string | Date | null): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function evaluateDecisionEvidence(
  snapshot: DecisionSnapshotEvidence | null,
  marketId: string,
  decisionAt: Date,
  maxSnapshotAgeMs = MAX_DECISION_SNAPSHOT_AGE_MS,
): DecisionEvidence {
  if (!Number.isFinite(decisionAt.getTime())) throw new Error('decisionAt must be valid');
  if (!Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs < 0) {
    throw new Error('maxSnapshotAgeMs must be a non-negative safe integer');
  }

  const base = { decisionAt, maxSnapshotAgeMs };
  if (!snapshot || snapshot.marketId !== marketId) {
    return {
      ...base,
      status: 'MISSING_SNAPSHOT',
      marketSnapshotId: null,
      quoteCollectedAt: null,
      snapshotAgeMs: null,
      reason: 'missing usable market snapshot at decision time',
    };
  }

  const quoteCollectedAt = asValidDate(snapshot.quoteCollectedAt);
  if (!quoteCollectedAt) {
    return {
      ...base,
      status: 'MISSING_SNAPSHOT',
      marketSnapshotId: null,
      quoteCollectedAt: null,
      snapshotAgeMs: null,
      reason: 'market snapshot has no valid quote collection timestamp',
    };
  }

  const snapshotAgeMs = decisionAt.getTime() - quoteCollectedAt.getTime();
  if (snapshotAgeMs < 0) {
    return {
      ...base,
      status: 'FUTURE_SNAPSHOT',
      marketSnapshotId: snapshot.id,
      quoteCollectedAt,
      snapshotAgeMs,
      reason: `market snapshot is ${Math.abs(snapshotAgeMs)}ms after decision time`,
    };
  }
  if (snapshotAgeMs > maxSnapshotAgeMs) {
    return {
      ...base,
      status: 'STALE_SNAPSHOT',
      marketSnapshotId: snapshot.id,
      quoteCollectedAt,
      snapshotAgeMs,
      reason: `market snapshot is ${snapshotAgeMs}ms old (limit ${maxSnapshotAgeMs}ms)`,
    };
  }

  return {
    ...base,
    status: 'VALID',
    marketSnapshotId: snapshot.id,
    quoteCollectedAt,
    snapshotAgeMs,
    reason: 'market snapshot is valid at decision time',
  };
}
