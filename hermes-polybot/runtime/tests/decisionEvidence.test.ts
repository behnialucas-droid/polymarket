import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDecisionEvidence, evaluateSignalFreshness, MAX_SIGNAL_AGE_MS_DEFAULT } from '../src/lib/engine/decisionEvidence.ts';

const decisionAt = new Date('2026-07-31T12:00:00.000Z');
const snapshot = (quoteCollectedAt: string | Date | null, marketId = 'market-1') => ({
  id: 7,
  marketId,
  quoteCollectedAt,
});

test('decision evidence accepts current and exact-boundary snapshots', () => {
  const current = evaluateDecisionEvidence(snapshot('2026-07-31T12:00:00.000Z'), 'market-1', decisionAt, 60_000);
  assert.equal(current.status, 'VALID');
  assert.equal(current.snapshotAgeMs, 0);
  assert.equal(current.marketSnapshotId, 7);

  const boundary = evaluateDecisionEvidence(snapshot('2026-07-31T11:59:00.000Z'), 'market-1', decisionAt, 60_000);
  assert.equal(boundary.status, 'VALID');
  assert.equal(boundary.snapshotAgeMs, 60_000);
});

test('decision evidence rejects absent, mismatched, and malformed snapshots', () => {
  assert.equal(evaluateDecisionEvidence(null, 'market-1', decisionAt).status, 'MISSING_SNAPSHOT');
  assert.equal(evaluateDecisionEvidence(snapshot(null), 'market-1', decisionAt).status, 'MISSING_SNAPSHOT');
  assert.equal(evaluateDecisionEvidence(snapshot('not-a-date'), 'market-1', decisionAt).status, 'MISSING_SNAPSHOT');
  assert.equal(evaluateDecisionEvidence(snapshot('2026-07-31T12:00:00.000Z', 'other-market'), 'market-1', decisionAt).status, 'MISSING_SNAPSHOT');
});

test('decision evidence rejects stale snapshots', () => {
  const evidence = evaluateDecisionEvidence(snapshot('2026-07-31T11:58:59.999Z'), 'market-1', decisionAt, 60_000);
  assert.equal(evidence.status, 'STALE_SNAPSHOT');
  assert.equal(evidence.snapshotAgeMs, 60_001);
  assert.equal(evidence.marketSnapshotId, 7);
});

test('decision evidence rejects snapshots after the decision', () => {
  const evidence = evaluateDecisionEvidence(snapshot('2026-07-31T12:00:00.001Z'), 'market-1', decisionAt, 60_000);
  assert.equal(evidence.status, 'FUTURE_SNAPSHOT');
  assert.equal(evidence.snapshotAgeMs, -1);
  assert.equal(evidence.marketSnapshotId, 7);
});

test('decision evidence rejects invalid policy and decision timestamps', () => {
  assert.throws(() => evaluateDecisionEvidence(null, 'market-1', new Date('invalid')));
  assert.throws(() => evaluateDecisionEvidence(null, 'market-1', decisionAt, -1));
  assert.throws(() => evaluateDecisionEvidence(null, 'market-1', decisionAt, 0.5));
});

test('signal freshness: fresh within limit, stale beyond it', () => {
  const t = new Date('2026-08-01T00:20:00.000Z');
  const fresh = evaluateSignalFreshness('2026-08-01T00:05:00.000Z', null, t);
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.ageMs, 15 * 60_000);
  const stale = evaluateSignalFreshness('2026-07-31T23:00:00.000Z', null, t);
  assert.equal(stale.fresh, false);
  assert.match(stale.reason, /copy limit/);
});

test('signal freshness: prefers observedAt, falls back to provider timestamp', () => {
  const t = new Date('2026-08-01T00:20:00.000Z');
  const viaObserved = evaluateSignalFreshness('2026-08-01T00:19:00.000Z', '2026-07-01T00:00:00.000Z', t);
  assert.equal(viaObserved.fresh, true);
  const viaProvider = evaluateSignalFreshness(null, '2026-08-01T00:19:00.000Z', t);
  assert.equal(viaProvider.fresh, true);
});

test('signal freshness fails closed on missing or future timestamps', () => {
  const t = new Date('2026-08-01T00:20:00.000Z');
  assert.equal(evaluateSignalFreshness(null, null, t).fresh, false);
  assert.equal(evaluateSignalFreshness('not-a-date', undefined, t).fresh, false);
  const future = evaluateSignalFreshness('2026-08-01T01:00:00.000Z', null, t);
  assert.equal(future.fresh, false);
  assert.match(future.reason, /future/);
  assert.throws(() => evaluateSignalFreshness('2026-08-01T00:19:00.000Z', null, t, 0));
  assert.equal(MAX_SIGNAL_AGE_MS_DEFAULT, 20 * 60_000);
});
