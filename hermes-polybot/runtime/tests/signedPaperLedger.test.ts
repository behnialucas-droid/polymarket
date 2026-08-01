import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateOppositeLots,
  applySignedAction,
  collateralFor,
  markPnl,
  settlementPnl,
  sourceSideToAction,
} from '../src/lib/engine/signedPaperLedger.ts';

test('source SELL maps to an independent Hermes short action', () => {
  assert.equal(sourceSideToAction('BUY'), 'OPEN_LONG');
  assert.equal(sourceSideToAction('SELL'), 'OPEN_SHORT');
  assert.equal(sourceSideToAction('SELL', true), 'INCREASE_SHORT');
});

test('sell-first opens a short with conservative binary collateral', () => {
  const result = applySignedAction([], {
    action: 'OPEN_SHORT',
    requestedShares: 10,
    executionPrice: 0.35,
    entryFees: 0.1,
    collateralBuffer: 0.2,
  });
  assert.equal(result.closedShares, 0);
  assert.equal(result.openedShares, 10);
  assert.equal(result.entryCollateral, 6.8);
  assert.equal(collateralFor('SHORT', 10, 0.35, 0.1, 0.2), 6.8);
});

test('open short preserves independent Hermes long inventory', () => {
  const result = applySignedAction([
    { id: 1, direction: 'LONG', openedShares: 3, remainingShares: 3, entryPrice: 0.4, entryFees: 0.03, collateral: 1.23 },
    { id: 2, direction: 'LONG', openedShares: 4, remainingShares: 4, entryPrice: 0.5, entryFees: 0.04, collateral: 2.04 },
  ], {
    action: 'OPEN_SHORT',
    requestedShares: 5,
    executionPrice: 0.6,
    entryFees: 0.05,
    collateralBuffer: 0.1,
  });
  assert.equal(result.closedShares, 0);
  assert.equal(result.openedShares, 5);
  assert.equal(result.closes.length, 0);
  assert.equal(result.releasedCollateral, 0);
  assert.equal(result.entryCollateral, 2.15);
});

test('source short is not an implicit long reversal', () => {
  const result = applySignedAction([
    { id: 1, direction: 'LONG', openedShares: 3, remainingShares: 3, entryPrice: 0.4, entryFees: 0, collateral: 1.2 },
  ], {
    action: 'OPEN_SHORT',
    requestedShares: 5,
    executionPrice: 0.6,
    entryFees: 0.1,
    collateralBuffer: 0.2,
  });
  assert.equal(result.closedShares, 0);
  assert.equal(result.openedShares, 5);
  assert.ok(Math.abs(result.entryCollateral - 2.3) < 1e-9);
  assert.equal(result.releasedCollateral, 0);
});

test('explicit reduce closes only requested inventory and never opens a reversal', () => {
  const result = applySignedAction([
    { id: 1, direction: 'LONG', openedShares: 5, remainingShares: 5, entryPrice: 0.4, entryFees: 0, collateral: 2 },
    { id: 2, direction: 'SHORT', openedShares: 4, remainingShares: 4, entryPrice: 0.6, entryFees: 0, collateral: 1.6 },
  ], {
    action: 'REDUCE_LONG',
    requestedShares: 6,
    executionPrice: 0.4,
    entryFees: 0,
    collateralBuffer: 0,
  });
  assert.equal(result.direction, 'LONG');
  assert.equal(result.closedShares, 5);
  assert.equal(result.openedShares, 0);
  assert.equal(result.unmatchedShares, 1);
  assert.equal(result.closes.length, 1);
  assert.equal(result.closes[0].id, 1);
});

test('flatten requires direction-specific orchestration', () => {
  assert.throws(() => applySignedAction([
    { id: 1, direction: 'LONG', openedShares: 1, remainingShares: 1, entryPrice: 0.4, entryFees: 0, collateral: 0.4 },
  ], {
    action: 'FLATTEN',
    requestedShares: 1,
    executionPrice: 0.5,
    entryFees: 0,
    collateralBuffer: 0,
  }), /direction-specific orchestration/);
});

test('reduce computes realized long PnL using executable exit price and fees', () => {
  const result = applySignedAction([
    { id: 1, direction: 'LONG', openedShares: 10, remainingShares: 10, entryPrice: 0.4, entryFees: 0.1, collateral: 4.1 },
  ], {
    action: 'REDUCE_LONG',
    requestedShares: 5,
    executionPrice: 0.6,
    entryFees: 0,
    exitFees: 0.05,
    collateralBuffer: 0,
  });
  assert.equal(result.closedShares, 5);
  assert.ok(Math.abs(result.realizedPnl - 0.9) < 1e-9);
});

test('reduce computes realized short PnL using inverse binary exit value', () => {
  const result = applySignedAction([
    { id: 1, direction: 'SHORT', openedShares: 10, remainingShares: 10, entryPrice: 0.6, entryFees: 0.1, collateral: 4.1 },
  ], {
    action: 'REDUCE_SHORT',
    requestedShares: 5,
    executionPrice: 0.3,
    entryFees: 0,
    exitFees: 0.05,
    collateralBuffer: 0,
  });
  assert.equal(result.closedShares, 5);
  assert.ok(Math.abs(result.realizedPnl - 1.4) < 1e-9);
});

test('long collateral excludes short-only buffer', () => {
  assert.equal(collateralFor('LONG', 10, 0.4, 0.1, 9), 4.1);
});

test('short mark and settlement PnL use inverse binary payoff', () => {
  assert.ok(Math.abs(markPnl('SHORT', 10, 0.6, 0.3, 0.1) - 2.9) < 1e-9);
  assert.ok(Math.abs(settlementPnl('SHORT', 10, 0.6, 0, 0.1, 0.1) - 5.8) < 1e-9);
  assert.ok(Math.abs(settlementPnl('SHORT', 10, 0.6, 1, 0.1, 0.1) + 4.2) < 1e-9);
});

test('allocation never closes same-side lots or creates negative shares', () => {
  const result = allocateOppositeLots([
    { id: 1, direction: 'SHORT', openedShares: 2, remainingShares: 2, entryPrice: 0.7, entryFees: 0, collateral: 0.6 },
  ], 'SHORT', 4);
  assert.equal(result.matchedShares, 0);
  assert.equal(result.unmatchedShares, 4);
  assert.equal(result.closes.length, 0);
});

test('signed ledger rejects invalid price and negative cost inputs', () => {
  assert.throws(() => collateralFor('SHORT', 1, 1, 0, 0), /executionPrice/);
  assert.throws(() => markPnl('LONG', 1, 0.5, 0.4, -1), /entryCosts/);
});
