import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDecisionEvidence } from '../src/lib/engine/decisionEvidence.ts';

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
