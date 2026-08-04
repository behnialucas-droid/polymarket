// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
export const MAX_DECISION_SNAPSHOT_AGE_MS = 60_000;

/** Copy signals expire: a source trade older than this at decision time is never
 * copied, no matter how fresh the quote is. Refreshing a quote for an old signal
 * would be lookahead-adjacent — the wallet's edge was priced in long ago. */
export const MAX_SIGNAL_AGE_MS_DEFAULT = 20 * 60_000;

export interface SignalFreshness {
  fresh: boolean;
  /** null when no usable timestamp exists (fails closed to not-fresh). */
  ageMs: number | null;
  reason: string;
}

/** Age of the source signal at decision time. Prefers Hermes observation time
 * (observedAt); falls back to the provider event timestamp. Unparsable or
 * future timestamps fail closed to not-fresh. Pure: clock is a parameter. */
export function evaluateSignalFreshness(
  observedAtIso: string | Date | null | undefined,
  providerTimestampIso: string | Date | null | undefined,
  decisionAt: Date,
  maxSignalAgeMs = MAX_SIGNAL_AGE_MS_DEFAULT,
): SignalFreshness {
  if (!Number.isSafeInteger(maxSignalAgeMs) || maxSignalAgeMs <= 0) {
    throw new Error('maxSignalAgeMs must be a positive safe integer');
  }
  const anchor = asValidDate(observedAtIso ?? null) ?? asValidDate(providerTimestampIso ?? null);
  if (!anchor) {
    return { fresh: false, ageMs: null, reason: 'source signal has no usable timestamp' };
  }
  const ageMs = decisionAt.getTime() - anchor.getTime();
  if (ageMs < 0) {
    return { fresh: false, ageMs, reason: `source signal timestamp is ${Math.abs(ageMs)}ms in the future` };
  }
  if (ageMs > maxSignalAgeMs) {
    return { fresh: false, ageMs, reason: `source signal is ${ageMs}ms old (copy limit ${maxSignalAgeMs}ms)` };
  }
  return { fresh: true, ageMs, reason: 'source signal is fresh enough to copy' };
}

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
