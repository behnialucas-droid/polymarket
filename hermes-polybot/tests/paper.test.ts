import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/lib/db.ts';
import { createPaperTrade, computePnl, updateOpenPnl, reviewOutcomes, computeBenchmarks } from '../src/lib/engine/paperTrading.ts';
import { scoreTrade } from '../src/lib/engine/tradeScoring.ts';
import { DEFAULT_RULES } from '../src/lib/engine/rules.ts';
import type { WalletTrade, MarketData, DataAdapter } from '../src/lib/adapters/types.ts';

const trade: WalletTrade = { walletAddress: '0xw', marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.5, size: 100, timestamp: new Date().toISOString(), marketCategory: 'politics' };
const market: MarketData = { marketId: 'm1', yesPrice: 0.5, noPrice: 0.5, spread: 0.02, liquidity: 20000, timeToResolutionHours: 50, resolved: false };
const wallet = { globalScore: 0.8, roi30d: 0.3, consistencyScore: 0.8, copyabilityScore: 0.8, bestCategory: 'politics', categoryStrengths: { politics: 0.9 } };

function journalRow(db: any, decision = 'paper_copy'): number {
  const r = db.prepare("INSERT INTO DecisionJournal (walletAddress, marketId, decision, spreadScore, liquidityScore, entryTimingScore) VALUES ('0xw','m1',?,0.9,0.9,0.9)").run(decision);
  return Number(r.lastInsertRowid);
}

test('paper trade creation: size bounded $5-$20, entry from market', () => {
  const db = openMemoryDb();
  const d = scoreTrade(trade, market, wallet, DEFAULT_RULES);
  assert.equal(d.decision, 'paper_copy');
  const id = createPaperTrade(db, journalRow(db), trade, market, d, true);
  const row = db.prepare('SELECT * FROM PaperTrade WHERE id = ?').get(id) as any;
  assert.ok(row.simulatedPositionSize >= 5 && row.simulatedPositionSize <= 20);
  assert.equal(row.status, 'open');
  assert.equal(row.entryPrice, 0.5);
});

test('paper trade creation: refuses non-copy decisions and out-of-bounds size', () => {
  const db = openMemoryDb();
  const d = scoreTrade(trade, market, wallet, DEFAULT_RULES);
  assert.throws(() => createPaperTrade(db, 1, trade, market, { ...d, decision: 'skip' }, true));
  assert.throws(() => createPaperTrade(db, 1, trade, market, { ...d, simulatedPositionSize: 50 }, true));
});

test('computePnl: shares math', () => {
  // $10 at 0.5 = 20 shares; price to 0.6 = +$2
  assert.equal(computePnl(0.5, 0.6, 10), 2);
  assert.equal(computePnl(0.5, 0, 10), -10);
  assert.equal(computePnl(0.5, 1, 10), 10);
});

function fakeAdapter(price: number, resolved = false, resolvedOutcome?: string): DataAdapter {
  return {
    source: 'fake', isDemo: true,
    fetchLeaderboard: async () => [],
    fetchWalletTrades: async () => [],
    fetchMarket: async () => ({ ...market, resolved, resolvedOutcome, yesPrice: price, noPrice: 1 - price }),
    fetchPrice: async () => price,
  };
}

test('hourly PnL update writes snapshots and unrealized pnl', async () => {
  const db = openMemoryDb();
  const d = scoreTrade(trade, market, wallet, DEFAULT_RULES);
  const id = createPaperTrade(db, journalRow(db), trade, market, d, true);
  const n = await updateOpenPnl(db, fakeAdapter(0.6));
  assert.equal(n, 1);
  const row = db.prepare('SELECT * FROM PaperTrade WHERE id = ?').get(id) as any;
  assert.equal(row.currentPrice, 0.6);
  assert.ok(row.unrealizedPnl > 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM PnlSnapshot').get() as any).n, 1);
});

test('outcome review resolves winners at $1 and writes OutcomeReview', async () => {
  const db = openMemoryDb();
  const d = scoreTrade(trade, market, wallet, DEFAULT_RULES);
  const jid = journalRow(db);
  createPaperTrade(db, jid, trade, market, d, true);
  const n = await reviewOutcomes(db, fakeAdapter(1, true, 'YES'));
  assert.equal(n, 1);
  const pt = db.prepare('SELECT * FROM PaperTrade').get() as any;
  assert.equal(pt.status, 'resolved');
  assert.ok(pt.realizedPnl > 0);
  const rev = db.prepare('SELECT * FROM OutcomeReview').get() as any;
  assert.equal(rev.wasDecisionGood, 1);
  assert.equal((db.prepare('SELECT reviewOutcome FROM DecisionJournal WHERE id = ?').get(jid) as any).reviewOutcome, 'good');
});

test('benchmark comparison: bot vs blind copy vs skip buckets', async () => {
  const db = openMemoryDb();
  // observed trade that was skipped but would have won -> missed winner
  const ot = db.prepare("INSERT INTO ObservedTrade (walletAddress, marketId, outcome, side, walletEntryPrice, size, timestamp) VALUES ('0xw','m2','YES','BUY',0.4,100,'2026-01-01')").run();
  db.prepare("INSERT INTO DecisionJournal (observedTradeId, walletAddress, marketId, decision) VALUES (?,'0xw','m2','skip')").run(Number(ot.lastInsertRowid));
  db.prepare(`INSERT INTO MarketSnapshot (marketId, collectedAt, rawMarketJson) VALUES ('m2','2026-01-01','{"resolvedOutcome":"YES"}')`).run();
  const b = computeBenchmarks(db);
  assert.equal(b.skipped.trades, 1);
  assert.equal(b.missedWinners, 1);
  assert.ok(b.blindCopy.pnl > 0);
});
