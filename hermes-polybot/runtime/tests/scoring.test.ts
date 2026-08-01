import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreWallet, walletStatus, type TradeWithMarket } from '../src/lib/engine/walletScoring.ts';
import { scoreTrade } from '../src/lib/engine/tradeScoring.ts';
import { DEFAULT_RULES } from '../src/lib/engine/rules.ts';
import type { WalletTrade, MarketData } from '../src/lib/adapters/types.ts';

const NOW = Date.parse('2026-07-30T00:00:00.000Z');
const hoursFromNow = (h: number) => new Date(NOW + h * 3.6e6).toISOString();

function mkTrade(over: Partial<WalletTrade> = {}): WalletTrade {
  return { walletAddress: '0xabc', marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.5, size: 100, timestamp: new Date(NOW).toISOString(), marketCategory: 'politics', ...over };
}
/** Default fixture is a SHORT-TERM market: resolves 6h out, well inside the 24h ceiling. */
function mkMarket(over: Partial<MarketData> = {}): MarketData {
  return { marketId: 'm1', yesPrice: 0.52, noPrice: 0.48, spread: 0.02, liquidity: 20000, endDateIso: hoursFromNow(6), timeToResolutionHours: 6, resolved: false, ...over };
}
function item(pnlPerDollar?: number, t: Partial<WalletTrade> = {}, m: Partial<MarketData> = {}): TradeWithMarket {
  return { trade: mkTrade(t), market: mkMarket(m), pnlPerDollar };
}

test('wallet scoring: consistent winner scores high', () => {
  const items = Array.from({ length: 12 }, (_, i) => item(0.3, { marketId: `m${i}`, size: 100 }));
  const s = scoreWallet(items);
  assert.ok(s.globalScore > 0.5, `expected > 0.5, got ${s.globalScore}`);
  assert.equal(s.oneHitWonderPenalty, 0);
  assert.equal(s.winRate30d, 1);
});

test('one-hit-wonder penalty: single huge win penalized', () => {
  const items = [
    item(5.0, { marketId: 'big', size: 500 }), // one massive win
    ...Array.from({ length: 7 }, (_, i) => item(-0.2, { marketId: `s${i}`, size: 50 })),
  ];
  const s = scoreWallet(items);
  assert.ok(s.oneHitWonderPenalty > 0.5, `expected penalty > 0.5, got ${s.oneHitWonderPenalty}`);
  const balanced = scoreWallet(Array.from({ length: 8 }, (_, i) => item(0.25, { marketId: `b${i}`, size: 100 })));
  assert.ok(s.globalScore < balanced.globalScore, 'one-hit wonder must score below balanced wallet');
});

test('one-hit-wonder penalty: too few resolved trades penalized', () => {
  const s = scoreWallet([item(0.5), item(0.4, { marketId: 'm2' })]);
  assert.ok(s.oneHitWonderPenalty >= 0.3);
});

test('copyability: illiquid wide-spread wallet scores low', () => {
  const bad = scoreWallet(Array.from({ length: 10 }, (_, i) => item(0.2, { marketId: `m${i}` }, { liquidity: 50, spread: 0.15 })));
  const good = scoreWallet(Array.from({ length: 10 }, (_, i) => item(0.2, { marketId: `m${i}` }, { liquidity: 80000, spread: 0.01 })));
  assert.ok(bad.copyabilityScore < good.copyabilityScore);
  assert.match(bad.copyabilityNotes, /illiquid|wide/);
});

test('wallet status: thresholds drive track/watch/ignore', () => {
  const good = scoreWallet(Array.from({ length: 15 }, (_, i) => item(0.3, { marketId: `m${i}` }, { liquidity: 80000, spread: 0.01 })));
  assert.equal(walletStatus(good, 0.5).status, 'track');
  const bad = scoreWallet(Array.from({ length: 10 }, (_, i) => item(-0.5, { marketId: `m${i}` }, { liquidity: 10, spread: 0.2 })));
  assert.equal(walletStatus(bad, 0.5).status, 'ignore');
});

const strongWallet = { globalScore: 0.8, roi30d: 0.3, consistencyScore: 0.8, copyabilityScore: 0.8, bestCategory: 'politics', categoryStrengths: { politics: 0.9 } };

test('trade scoring: clean setup on strong wallet = paper_copy with $5-$20 size', () => {
  const d = scoreTrade(mkTrade(), mkMarket(), strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'paper_copy');
  assert.ok(d.simulatedPositionSize! >= 5 && d.simulatedPositionSize! <= 20);
  assert.ok(d.reasons.length > 0);
});

test('trade scoring: illiquid market gated to skip', () => {
  const d = scoreTrade(mkTrade(), mkMarket({ liquidity: 10 }), strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'skip');
  assert.ok(d.risks.some((r) => r.includes('liquidity')));
});

test('trade scoring: wide spread gated to skip', () => {
  const d = scoreTrade(mkTrade(), mkMarket({ spread: 0.2 }), strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'skip');
  assert.ok(d.risks.some((r) => r.includes('spread')));
});

test('trade scoring: price moved too far = skip (too late)', () => {
  const d = scoreTrade(mkTrade({ price: 0.3 }), mkMarket({ yesPrice: 0.6 }), strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'skip');
  assert.ok(d.risks.some((r) => r.includes('price moved')));
});

test('trade scoring: weak wallet gated to skip', () => {
  const d = scoreTrade(mkTrade(), mkMarket(), { ...strongWallet, globalScore: 0.2 }, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'skip');
});

test('trade scoring: resolved market gated to skip', () => {
  const d = scoreTrade(mkTrade(), mkMarket({ resolved: true }), strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'skip');
});

test('trade scoring: SELL is a qualified short signal with collateral risk', () => {
  const d = scoreTrade(mkTrade({ side: 'SELL' }), mkMarket(), strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'paper_copy');
  assert.ok(d.risks.some((risk) => risk.includes('signed short action')));
});
