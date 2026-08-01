import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, percentile, maxDrawdown, blockBootstrapTotal } from '../src/lib/research/stats.ts';

test('mulberry32 is deterministic and uniform-ish', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  assert.deepEqual(seqA, seqB);
  const c = mulberry32(43);
  assert.notDeepEqual(seqA, Array.from({ length: 5 }, () => c()));
  const rand = mulberry32(7);
  let total = 0;
  for (let i = 0; i < 10_000; i++) total += rand();
  assert.ok(Math.abs(total / 10_000 - 0.5) < 0.02);
});

test('percentile interpolates and rejects bad input', () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(percentile(sorted, 0), 1);
  assert.equal(percentile(sorted, 1), 5);
  assert.equal(percentile(sorted, 0.5), 3);
  assert.equal(percentile(sorted, 0.25), 2);
  assert.throws(() => percentile([], 0.5));
  assert.throws(() => percentile(sorted, 1.5));
});

test('maxDrawdown measures peak-to-trough of the equity path', () => {
  assert.equal(maxDrawdown([1, 1, 1]), 0);
  assert.equal(maxDrawdown([2, -3, 1]), 3);
  assert.equal(maxDrawdown([-1, -1]), 2);
  assert.equal(maxDrawdown([]), 0);
});

test('block bootstrap is deterministic under a fixed seed', () => {
  const series = [1, -2, 3, 0.5, -1, 2, -0.5, 1.5, 0.2, -0.7];
  const r1 = blockBootstrapTotal(series, { seed: 123, resamples: 500, blockLength: 3 });
  const r2 = blockBootstrapTotal(series, { seed: 123, resamples: 500, blockLength: 3 });
  assert.deepEqual(r1, r2);
  const r3 = blockBootstrapTotal(series, { seed: 124, resamples: 500, blockLength: 3 });
  assert.notEqual(r1.ciLow, r3.ciLow);
});

test('bootstrap CI behaves sanely on known distributions', () => {
  const allPositive = Array.from({ length: 30 }, () => 1);
  const pos = blockBootstrapTotal(allPositive, { seed: 5, resamples: 1000 });
  assert.equal(pos.observedTotal, 30);
  assert.equal(pos.probabilityOfLoss, 0);
  assert.ok(pos.ciLow > 0);

  const allNegative = Array.from({ length: 30 }, () => -1);
  const neg = blockBootstrapTotal(allNegative, { seed: 5, resamples: 1000 });
  assert.equal(neg.probabilityOfLoss, 1);
  assert.ok(neg.ciHigh < 0);

  // Zero-mean noise: CI straddles zero, P(loss) is near a half.
  const rand = mulberry32(9);
  const noise = Array.from({ length: 60 }, () => rand() - 0.5);
  const mixed = blockBootstrapTotal(noise, { seed: 5, resamples: 2000 });
  assert.ok(mixed.ciLow < mixed.observedTotal && mixed.observedTotal < mixed.ciHigh);
  assert.ok(mixed.probabilityOfLoss > 0.05 && mixed.probabilityOfLoss < 0.95);
});

test('bootstrap rejects degenerate input', () => {
  assert.throws(() => blockBootstrapTotal([1], { seed: 1 }));
  assert.throws(() => blockBootstrapTotal([1, Number.NaN], { seed: 1 }));
  assert.throws(() => blockBootstrapTotal([1, 2], { seed: 1, ciLevel: 1 }));
});
