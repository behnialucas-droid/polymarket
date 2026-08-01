/**
 * Wallet Classification Unit Tests — Foundation v2 Phase 4 Verification
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type ClassificationProfileInput } from '../src/lib/classify.ts';

const BASE_PROFILE: ClassificationProfileInput = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  globalScore: 85.0,
  tradeCount30d: 25,
  resolvedTradeCount30d: 20,
  realizedPnl30d: 1500.0,
  consistency: 0.75,
  maxDrawdown30d: 0.12,
  daysSinceLastTrade: 2,
  oneHitWonderFlag: false,
  topTradePnlShare: 0.15,
  shortTermShare: 0.8,
};

test('classify — pure function determinism (100 runs over fixed input)', () => {
  const first = classify(BASE_PROFILE);
  assert.equal(first.status, 'copy');

  for (let i = 0; i < 100; i++) {
    const res = classify(BASE_PROFILE);
    assert.deepEqual(res, first);
  }
});

test('classify — hard disqualifiers', () => {
  // Fewer than 5 trades -> ignore
  assert.equal(
    classify({ ...BASE_PROFILE, tradeCount30d: 4 }).status,
    'ignore'
  );

  // Inactive > 21 days -> ignore
  assert.equal(
    classify({ ...BASE_PROFILE, daysSinceLastTrade: 22 }).status,
    'ignore'
  );

  // Negative 30d PnL -> ignore
  assert.equal(
    classify({ ...BASE_PROFILE, realizedPnl30d: 0 }).status,
    'ignore'
  );

  // One-hit-wonder -> watch
  assert.equal(
    classify({ ...BASE_PROFILE, oneHitWonderFlag: true }).status,
    'watch'
  );
});

test('classify — positive gates for copy tier', () => {
  // All gates pass -> copy
  assert.equal(classify(BASE_PROFILE).status, 'copy');

  // Low consistency -> watch or ignore
  assert.equal(
    classify({ ...BASE_PROFILE, consistency: 0.40 }).status,
    'watch'
  );

  // High drawdown -> watch or ignore
  assert.equal(
    classify({ ...BASE_PROFILE, maxDrawdown30d: 0.45 }).status,
    'watch'
  );
});

test('classify — hysteresis: promote at 70, demote only below 65', () => {
  // Score 68 with previous status 'copy' and only 1 failed gate -> retained as copy
  const retained = classify(
    { ...BASE_PROFILE, globalScore: 68.0 },
    'copy'
  );
  assert.equal(retained.status, 'copy');
  assert.ok(retained.reason.includes('retained (hysteresis)'));

  // Score 68 with no previous status -> watch
  const fresh = classify({ ...BASE_PROFILE, globalScore: 68.0 });
  assert.equal(fresh.status, 'watch');
});
