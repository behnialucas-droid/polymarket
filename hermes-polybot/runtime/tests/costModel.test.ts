import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExecutionCost, type CostModelParams } from '../src/lib/engine/costModel.ts';

const params: CostModelParams = {
  version: 'cost-test',
  feeBps: 20,
  halfSpreadFloorBps: 50,
  impactCoeff: 80,
  impactExponent: 0.5,
  latencyMs: 4000,
  latencyDriftBpsPerSec: 2,
  maxFillFraction: 0.05,
};
const quote = { bestBid: 0.54, bestAsk: 0.56, liquidity: 20000 };

test('cost model always charges adversely for both directions', () => {
  const long = computeExecutionCost(params, { direction: 'LONG', requestedShares: 20, quote });
  const short = computeExecutionCost(params, { direction: 'SHORT', requestedShares: 20, quote });
  assert.ok(long.executable && short.executable);
  assert.ok(long.effectivePrice > quote.bestAsk, 'long pays above the ask');
  assert.ok(short.effectivePrice < quote.bestBid, 'short receives below the bid');
  assert.ok(long.feesMicros > 0n);
  assert.ok(long.slippageMicros > 0n);
});

test('cost is monotone: a bigger order is never cheaper per share', () => {
  let prev = 0;
  for (const shares of [10, 100, 1000, 5000]) {
    const c = computeExecutionCost(params, { direction: 'LONG', requestedShares: shares, quote });
    assert.ok(c.executable);
    assert.ok(c.effectivePrice >= prev, `effective price fell from ${prev} to ${c.effectivePrice} at ${shares} shares`);
    prev = c.effectivePrice;
  }
});

test('fill size is capped by the liquidity participation limit', () => {
  const c = computeExecutionCost(params, { direction: 'LONG', requestedShares: 1e6, quote });
  assert.ok(c.executable);
  assert.ok(c.expectedFillShares < 1e6);
  assert.ok(c.expectedFillShares <= (params.maxFillFraction * quote.liquidity) / c.effectivePrice + 1e-9);
});

test('unexecutable candidates are refused, never clamped', () => {
  assert.equal(computeExecutionCost(params, { direction: 'LONG', requestedShares: 0, quote }).executable, false);
  assert.equal(computeExecutionCost(params, { direction: 'LONG', requestedShares: 10, quote: { ...quote, liquidity: 0 } }).executable, false);
  assert.equal(computeExecutionCost(params, { direction: 'LONG', requestedShares: 10, quote: { bestBid: 0, bestAsk: 0.5, liquidity: 1000 } }).executable, false);
  // A long at the extreme of the book cannot be pushed past 1.0
  const nearOne = computeExecutionCost(params, { direction: 'LONG', requestedShares: 5000, quote: { bestBid: 0.985, bestAsk: 0.999, liquidity: 800 } });
  assert.equal(nearOne.executable, false);
  assert.match(nearOne.reason ?? '', /outside \(0, 1\)/);
});

test('cost model rejects out-of-range parameters', () => {
  assert.throws(() => computeExecutionCost({ ...params, maxFillFraction: 0 }, { direction: 'LONG', requestedShares: 1, quote }));
  assert.throws(() => computeExecutionCost({ ...params, impactExponent: 5 }, { direction: 'LONG', requestedShares: 1, quote }));
  assert.throws(() => computeExecutionCost({ ...params, feeBps: -1 }, { direction: 'LONG', requestedShares: 1, quote }));
});
