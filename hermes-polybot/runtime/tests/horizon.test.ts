/**
 * Short-term horizon filter — regression tests.
 *
 * The clock is pinned in every case. A test that depends on the wall clock would
 * pass today and fail tomorrow, which is exactly the class of bug this module exists to kill.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hoursToResolution,
  isShortTerm,
  holdHours,
  shortTermShare,
  horizonScore,
  isShortTermSubject,
} from '../src/lib/engine/horizon.ts';
import { scoreWallet, walletStatus, type TradeWithMarket } from '../src/lib/engine/walletScoring.ts';
import { scoreTrade } from '../src/lib/engine/tradeScoring.ts';
import { DEFAULT_RULES } from '../src/lib/engine/rules.ts';
import { classify, type ClassificationProfileInput } from '../src/lib/classify.ts';
import type { MarketData, WalletTrade } from '../src/lib/adapters/types.ts';

const NOW = Date.parse('2026-07-30T00:00:00.000Z');
const at = (h: number) => new Date(NOW + h * 3.6e6).toISOString();

const mkMarket = (over: Partial<MarketData> = {}): MarketData => ({
  marketId: 'm1', yesPrice: 0.52, noPrice: 0.48, spread: 0.02, liquidity: 20000,
  endDateIso: at(6), resolved: false, ...over,
});
const mkTrade = (over: Partial<WalletTrade> = {}): WalletTrade => ({
  walletAddress: '0xabc', marketId: 'm1', outcome: 'YES', side: 'BUY',
  price: 0.5, size: 100, timestamp: new Date(NOW).toISOString(), marketCategory: 'crypto', ...over,
});

test('hoursToResolution prefers the absolute deadline over the stored relative value', () => {
  // A snapshot taken hours ago claims 99h; the absolute deadline says 6h. Trust the deadline.
  assert.equal(hoursToResolution(mkMarket({ timeToResolutionHours: 99 }), NOW), 6);
  // Fallback only when there is no deadline at all.
  assert.equal(hoursToResolution(mkMarket({ endDateIso: undefined, timeToResolutionHours: 12 }), NOW), 12);
  assert.equal(hoursToResolution(mkMarket({ endDateIso: undefined }), NOW), undefined);
});

test('isShortTerm accepts near markets, rejects far ones', () => {
  assert.equal(isShortTerm(mkMarket({ endDateIso: at(6) }), NOW), true);
  assert.equal(isShortTerm(mkMarket({ endDateIso: at(23.9) }), NOW), true);
  assert.equal(isShortTerm(mkMarket({ endDateIso: at(72) }), NOW), false);
  assert.equal(isShortTerm(mkMarket({ endDateIso: at(24 * 60) }), NOW), false);
});

test('REGRESSION: expired-but-unsettled market is rejected, not accepted', () => {
  // endDate passed 5h ago, market still open. The old `ttr > max` gate let this through
  // because -5 is not greater than 24 — capital then sat in the position indefinitely.
  const stale = mkMarket({ endDateIso: at(-5) });
  assert.equal(isShortTerm(stale, NOW), false);

  const d = scoreTrade(mkTrade(), stale, strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'skip');
  assert.ok(d.risks.some((r) => r.includes('expired')), `risks: ${d.risks.join(' | ')}`);
});

test('market with no end date is rejected (fail closed)', () => {
  const d = scoreTrade(mkTrade(), mkMarket({ endDateIso: undefined }), strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'skip');
  assert.ok(d.risks.some((r) => r.includes('no end date')));
});

test('holdHours measures entry -> deadline and ignores the current clock', () => {
  const m = mkMarket({ endDateIso: at(10) });
  const t = mkTrade({ timestamp: new Date(NOW - 2 * 3.6e6).toISOString() }); // entered 2h before NOW
  assert.equal(holdHours(t.timestamp, m), 12);
  assert.equal(holdHours(t.timestamp, mkMarket({ endDateIso: undefined })), undefined);
});

test('shortTermShare counts commitments, not calendar position', () => {
  const items = [
    { trade: mkTrade(), market: mkMarket({ endDateIso: at(6) }) },
    { trade: mkTrade(), market: mkMarket({ endDateIso: at(12) }) },
    { trade: mkTrade(), market: mkMarket({ endDateIso: at(240) }) },
    { trade: mkTrade(), market: mkMarket({ endDateIso: at(500) }) },
  ];
  assert.equal(shortTermShare(items, 24), 0.5);
  assert.equal(shortTermShare([], 24), 0);
});

test('horizonScore rewards imminent resolution (inverse of the old timing signal)', () => {
  assert.ok(horizonScore(1, 24) > horizonScore(20, 24));
  assert.equal(horizonScore(24, 24), 0);
  assert.equal(horizonScore(undefined, 24), 0);
  assert.equal(horizonScore(-3, 24), 0);
});

test('isShortTermSubject is a hint, matching crypto/daily language', () => {
  assert.equal(isShortTermSubject('Bitcoin up or down on July 30?'), true);
  assert.equal(isShortTermSubject(undefined, 'eth-price-today'), true);
  assert.equal(isShortTermSubject('Who wins the 2028 presidential election?'), false);
  assert.equal(isShortTermSubject(), false);
});

const strongWallet = {
  globalScore: 0.8, roi30d: 0.3, consistencyScore: 0.8, copyabilityScore: 0.8,
  bestCategory: 'crypto', categoryStrengths: { crypto: 0.9 },
};

const longTermItems = (n: number): TradeWithMarket[] =>
  Array.from({ length: n }, (_, i) => ({
    trade: mkTrade({ marketId: `m${i}` }),
    market: mkMarket({ marketId: `m${i}`, endDateIso: at(24 * 45), liquidity: 80000, spread: 0.01 }),
    pnlPerDollar: 0.3,
  }));

const shortTermItems = (n: number): TradeWithMarket[] =>
  Array.from({ length: n }, (_, i) => ({
    trade: mkTrade({ marketId: `m${i}` }),
    market: mkMarket({ marketId: `m${i}`, endDateIso: at(8), liquidity: 80000, spread: 0.01 }),
    pnlPerDollar: 0.3,
  }));

test('a profitable long-term wallet never reaches track, only watch', () => {
  const s = scoreWallet(longTermItems(15), DEFAULT_RULES.maxTimeToResolutionHours);
  assert.equal(s.shortTermShare, 0);
  assert.match(s.copyabilityNotes, /long-term/);

  const st = walletStatus(s, DEFAULT_RULES.minWalletGlobalScore, DEFAULT_RULES.minShortTermShare);
  assert.equal(st.status, 'watch');
  assert.match(st.reason, /short-term/);
});

test('an equally profitable short-term wallet is tracked and scores higher', () => {
  const shortW = scoreWallet(shortTermItems(15), DEFAULT_RULES.maxTimeToResolutionHours);
  const longW = scoreWallet(longTermItems(15), DEFAULT_RULES.maxTimeToResolutionHours);

  assert.equal(shortW.shortTermShare, 1);
  assert.ok(
    shortW.copyabilityScore > longW.copyabilityScore,
    `short ${shortW.copyabilityScore} must beat long ${longW.copyabilityScore}`,
  );
  assert.equal(
    walletStatus(shortW, DEFAULT_RULES.minWalletGlobalScore, DEFAULT_RULES.minShortTermShare).status,
    'track',
  );
});

test('classify gates on short-term share', () => {
  const base: ClassificationProfileInput = {
    address: '0xabc', globalScore: 85, tradeCount30d: 25, resolvedTradeCount30d: 20,
    realizedPnl30d: 1500, consistency: 0.75, maxDrawdown30d: 0.12, daysSinceLastTrade: 2,
    oneHitWonderFlag: false, topTradePnlShare: 0.15, shortTermShare: 0.8,
  };
  assert.equal(classify(base).status, 'copy');
  const longTerm = classify({ ...base, shortTermShare: 0.1 });
  assert.notEqual(longTerm.status, 'copy');
  assert.match(longTerm.reason, /short-term share/);
});

test('short-term trade on a strong wallet still copies, with horizon recorded', () => {
  const d = scoreTrade(mkTrade(), mkMarket({ endDateIso: at(6) }), strongWallet, DEFAULT_RULES, NOW);
  assert.equal(d.decision, 'paper_copy');
  assert.equal(d.scores.horizonScore, 0.75);
  assert.ok(d.reasons.some((r) => r.includes('resolves in 6h')));
  assert.ok(d.simulatedPositionSize! >= 5 && d.simulatedPositionSize! <= 20);
});
