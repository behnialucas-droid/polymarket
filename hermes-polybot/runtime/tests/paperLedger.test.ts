import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateFifoClose } from '../src/lib/engine/paperLedger.ts';

test('FIFO close consumes oldest lots and preserves later lots', () => {
  const result = allocateFifoClose([
    { id: 1, openedShares: 10, remainingShares: 10, costBasis: 4 },
    { id: 2, openedShares: 10, remainingShares: 10, costBasis: 6 },
  ], 15);
  assert.equal(result.matchedShares, 15);
  assert.equal(result.unmatchedShares, 0);
  assert.equal(result.closedCostBasis, 7);
  assert.deepEqual(result.closes, [
    { id: 1, closingShares: 10, remainingShares: 0, costBasis: 4 },
    { id: 2, closingShares: 5, remainingShares: 5, costBasis: 3 },
  ]);
});

test('oversell allocation closes available shares without negative inventory', () => {
  const result = allocateFifoClose([
    { id: 1, openedShares: 4, remainingShares: 4, costBasis: 2 },
  ], 10);
  assert.equal(result.matchedShares, 4);
  assert.equal(result.unmatchedShares, 6);
  assert.equal(result.closedCostBasis, 2);
  assert.equal(result.closes[0].remainingShares, 0);
});

test('allocation rejects malformed lots and invalid requested quantity', () => {
  assert.throws(() => allocateFifoClose([], 0), /requestedShares/);
  assert.throws(() => allocateFifoClose([{ id: 1, openedShares: 1, remainingShares: 2, costBasis: 1 }], 1), /invalid lot remainingShares/);
  assert.throws(() => allocateFifoClose([{ id: 1, openedShares: 1, remainingShares: 1, costBasis: -1 }], 1), /invalid lot costBasis/);
});

test('sell-first has no matching lots and cannot create negative inventory', () => {
  const result = allocateFifoClose([], 3);
  assert.equal(result.matchedShares, 0);
  assert.equal(result.unmatchedShares, 3);
  assert.equal(result.closes.length, 0);
});
