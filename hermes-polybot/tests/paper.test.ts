import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { createPaperTrade, computePnl, updateOpenPnl, reviewOutcomes, computeBenchmarks } from '../src/lib/engine/paperTrading.ts';
import { scoreTrade } from '../src/lib/engine/tradeScoring.ts';
import { DEFAULT_RULES } from '../src/lib/engine/rules.ts';
import type { WalletTrade, MarketData, DataAdapter } from '../src/lib/adapters/types.ts';

const db = getDb();
const trade: WalletTrade = { walletAddress: '0xw', marketId: 'm1', outcome: 'YES', side: 'BUY', price: 0.5, size: 100, timestamp: new Date().toISOString(), marketCategory: 'politics' };
const market: MarketData = { marketId: 'm1', yesPrice: 0.5, noPrice: 0.5, spread: 0.02, liquidity: 20000, timeToResolutionHours: 50, resolved: false };
const wallet = { globalScore: 0.8, roi30d: 0.3, consistencyScore: 0.8, copyabilityScore: 0.8, bestCategory: 'politics', categoryStrengths: { politics: 0.9 } };

async function journalRow(decision = 'paper_copy'): Promise<number> {
  const r = await db`INSERT INTO "DecisionJournal" ("walletAddress", "marketId", "decision", "spreadScore", "liquidityScore", "entryTimingScore") VALUES ('0xw','m1',${decision},0.9,0.9,0.9) RETURNING "id"`;
  return Number(r[0].id);
}

test('paper trade creation: size bounded $5-$20, entry from market', async () => {
  const d = scoreTrade(trade, market, wallet, DEFAULT_RULES);
  assert.equal(d.decision, 'paper_copy');
  const jid = await journalRow();
  const id = await createPaperTrade(db, jid, trade, market, d, true);
  const rows = await db`SELECT * FROM "PaperTrade" WHERE "id" = ${id}`;
  const row = rows[0];
  assert.ok(Number(row.simulatedPositionSize) >= 5 && Number(row.simulatedPositionSize) <= 20);
  assert.equal(row.status, 'open');
  assert.equal(Number(row.entryPrice), 0.5);
});

test('paper trade creation: refuses non-copy decisions and out-of-bounds size', async () => {
  const d = scoreTrade(trade, market, wallet, DEFAULT_RULES);
  const jid = await journalRow();
  await assert.rejects(async () => createPaperTrade(db, jid, trade, market, { ...d, decision: 'skip' }, true));
  await assert.rejects(async () => createPaperTrade(db, jid, trade, market, { ...d, simulatedPositionSize: 50 }, true));
});

test('computePnl: shares math', () => {
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
  const d = scoreTrade(trade, market, wallet, DEFAULT_RULES);
  const jid = await journalRow();
  const id = await createPaperTrade(db, jid, trade, market, d, true);
  const n = await updateOpenPnl(db, fakeAdapter(0.6));
  assert.ok(n >= 1);
  const rows = await db`SELECT * FROM "PaperTrade" WHERE "id" = ${id}`;
  assert.equal(Number(rows[0].currentPrice), 0.6);
  assert.ok(Number(rows[0].unrealizedPnl) > 0);
});

test('outcome review resolves winners at $1 and writes OutcomeReview', async () => {
  const d = scoreTrade(trade, market, wallet, DEFAULT_RULES);
  const jid = await journalRow();
  const id = await createPaperTrade(db, jid, trade, market, d, true);
  const n = await reviewOutcomes(db, fakeAdapter(1, true, 'YES'));
  assert.ok(n >= 1);
  const rows = await db`SELECT * FROM "PaperTrade" WHERE "id" = ${id}`;
  assert.equal(rows[0].status, 'resolved');
  assert.ok(Number(rows[0].realizedPnl) > 0);
});

test('benchmark comparison: bot vs blind copy vs skip buckets', async () => {
  const ot = await db`INSERT INTO "ObservedTrade" ("walletAddress", "marketId", "outcome", "side", "walletEntryPrice", "size", "timestamp") VALUES ('0xw','m2','YES','BUY',0.4,100,'2026-01-01') RETURNING "id"`;
  await db`INSERT INTO "DecisionJournal" ("observedTradeId", "walletAddress", "marketId", "decision") VALUES (${ot[0].id},'0xw','m2','skip')`;
  await db`INSERT INTO "MarketSnapshot" ("marketId", "collectedAt", "rawMarketJson") VALUES ('m2','2026-01-01','{"resolvedOutcome":"YES"}')`;
  const b = await computeBenchmarks(db);
  assert.ok(b.skipped.trades >= 1);
  assert.ok(b.missedWinners >= 1);
});
