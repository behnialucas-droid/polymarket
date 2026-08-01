import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResolution, settlementPayout, lotSettlementPnl, lotInvalidationPnl } from '../src/lib/engine/settlement.ts';
import type { MarketData } from '../src/lib/adapters/types.ts';

const market = (over: Partial<MarketData> = {}, raw: Record<string, unknown> = {}): MarketData => ({
  marketId: 'm1', yesPrice: 0.5, resolved: false, raw, ...over,
});

test('only an explicit provider resolution can CONFIRM', () => {
  const confirmed = evaluateResolution(market({ resolved: true, resolvedOutcome: 'Yes' }, { umaResolutionStatus: 'resolved' }));
  assert.equal(confirmed?.status, 'confirmed');
  assert.equal(confirmed?.resolvedOutcome, 'Yes');

  // closed + price heuristic without provider resolution can only PROPOSE
  const proposed = evaluateResolution(market({ resolved: true, resolvedOutcome: 'Yes' }));
  assert.equal(proposed?.status, 'proposed');

  // provider says resolved but no concrete outcome: nothing to act on
  assert.equal(evaluateResolution(market({ resolved: true }, { umaResolutionStatus: 'resolved' })), null);
  // open market: nothing
  assert.equal(evaluateResolution(market()), null);
  // disputed/unknown provider state never confirms
  assert.equal(evaluateResolution(market({ resolved: true, resolvedOutcome: 'Yes' }, { umaResolutionStatus: 'disputed' }))?.status, 'proposed');
});

test('settlement payout matches instrument outcome case-insensitively', () => {
  assert.equal(settlementPayout('Yes', 'YES'), 1);
  assert.equal(settlementPayout('No', 'Yes'), 0);
  assert.equal(settlementPayout(' yes ', 'Yes'), 1);
});

test('lot settlement PnL uses binary payoff for both directions', () => {
  const longLot = { direction: 'LONG' as const, openedShares: 10, remainingShares: 10, entryPrice: 0.4, entryFees: 0.1 };
  // long win: 10*(1-0.4) - 0.1 = 5.9 ; long loss: 10*(0-0.4) - 0.1 = -4.1
  assert.ok(Math.abs(lotSettlementPnl(longLot, 1) - 5.9) < 1e-9);
  assert.ok(Math.abs(lotSettlementPnl(longLot, 0) - -4.1) < 1e-9);

  const shortLot = { direction: 'SHORT' as const, openedShares: 10, remainingShares: 10, entryPrice: 0.6, entryFees: 0.1 };
  // short win (outcome false): 10*(0.6-0) - 0.1 = 5.9 ; short loss: 10*(0.6-1) - 0.1 = -4.1
  assert.ok(Math.abs(lotSettlementPnl(shortLot, 0) - 5.9) < 1e-9);
  assert.ok(Math.abs(lotSettlementPnl(shortLot, 1) - -4.1) < 1e-9);
});

test('partially reduced lots settle only remaining shares with pro-rata fees', () => {
  const lot = { direction: 'LONG' as const, openedShares: 10, remainingShares: 4, entryPrice: 0.5, entryFees: 0.2 };
  // 4*(1-0.5) - 0.2*(4/10) = 2 - 0.08 = 1.92
  assert.ok(Math.abs(lotSettlementPnl(lot, 1) - 1.92) < 1e-9);
  assert.equal(lotSettlementPnl({ ...lot, remainingShares: 0 }, 1), 0);
});

test('invalidation refunds collateral and sinks only allocated fees', () => {
  const lot = { direction: 'SHORT' as const, openedShares: 10, remainingShares: 5, entryPrice: 0.6, entryFees: 0.2 };
  assert.ok(Math.abs(lotInvalidationPnl(lot) - -0.1) < 1e-9);
  assert.equal(lotInvalidationPnl({ ...lot, remainingShares: 0 }), 0);
});
