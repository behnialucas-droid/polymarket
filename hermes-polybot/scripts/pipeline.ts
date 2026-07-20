/** Pipeline steps shared by scripts. Fail loud: adapter errors propagate. */
import type { DatabaseSync } from 'node:sqlite';
import { getAdapter, type DataAdapter } from '../src/lib/adapters/index.ts';
import { scoreWallet, walletStatus, type TradeWithMarket } from '../src/lib/engine/walletScoring.ts';
import { scoreTrade } from '../src/lib/engine/tradeScoring.ts';
import { createPaperTrade } from '../src/lib/engine/paperTrading.ts';
import { getActiveRules } from '../src/lib/engine/rules.ts';

export function since30d(): string {
  return new Date(Date.now() - 30 * 864e5).toISOString();
}

export async function runLeaderboardScan(db: DatabaseSync, adapter: DataAdapter, limit = 500): Promise<number> {
  const entries = await adapter.fetchLeaderboard(limit);
  db.prepare('INSERT INTO LeaderboardScan (source, scannedAt, walletCount, lookbackDays, rawSummaryJson, isDemo) VALUES (?,?,?,?,?,?)')
    .run(adapter.source, new Date().toISOString(), entries.length, 30, JSON.stringify(entries.slice(0, 50)), adapter.isDemo ? 1 : 0);
  const up = db.prepare(
    `INSERT INTO WalletProfile (address, label, sourceRank, isDemo) VALUES (?,?,?,?)
     ON CONFLICT(address) DO UPDATE SET label=excluded.label, sourceRank=excluded.sourceRank, updatedAt=datetime('now')`,
  );
  for (const e of entries) up.run(e.address, e.label ?? null, e.rank, adapter.isDemo ? 1 : 0);
  return entries.length;
}

export async function profileWallet(db: DatabaseSync, adapter: DataAdapter, address: string): Promise<void> {
  const trades = await adapter.fetchWalletTrades(address, since30d());
  const items: TradeWithMarket[] = [];
  const marketCache = new Map<string, any>();
  for (const t of trades) {
    if (!t.marketId) continue;
    let m = marketCache.get(t.marketId);
    if (!m) { 
      try {
        m = await adapter.fetchMarket(t.marketId); 
        marketCache.set(t.marketId, m); 
      } catch (e: any) {
        // Market may be archived/removed, skip this trade for scoring
        continue;
      }
    }
    let pnlPerDollar: number | undefined;
    if (m.resolved && m.resolvedOutcome && t.price > 0) {
      const won = m.resolvedOutcome.toUpperCase() === String(t.outcome).toUpperCase();
      pnlPerDollar = ((won ? 1 : 0) - t.price) / t.price;
    }
    items.push({ trade: t, market: m, pnlPerDollar });
  }
  const s = scoreWallet(items);
  const { rules } = getActiveRules(db);
  const st = walletStatus(s, rules.minWalletGlobalScore);
  db.prepare(
    `UPDATE WalletProfile SET status=?, statusReason=?, roi30d=?, consistencyScore=?, copyabilityScore=?, oneHitWonderPenalty=?, globalScore=?,
       bestCategory=?, categoryStrengthsJson=?, averageTradeSize=?, tradeCount30d=?, resolvedTradeCount30d=?, winRate30d=?,
       averageLiquidity=?, averageSpread=?, averageEntryTiming=?, copyabilityNotes=?, riskNotes=?, lastScannedAt=datetime('now'), updatedAt=datetime('now')
     WHERE address=?`,
  ).run(
    st.status, st.reason, s.roi30d, s.consistencyScore, s.copyabilityScore, s.oneHitWonderPenalty, s.globalScore,
    s.bestCategory, JSON.stringify(s.categoryStrengths), s.averageTradeSize, s.tradeCount30d, s.resolvedTradeCount30d, s.winRate30d,
    s.averageLiquidity, s.averageSpread, s.averageEntryTiming, s.copyabilityNotes, s.riskNotes, address,
  );
}

/** Detect trades from tracked wallets not yet observed; store them + market snapshots. */
export async function monitorTrades(db: DatabaseSync, adapter: DataAdapter): Promise<number> {
  const tracked = db.prepare("SELECT address FROM WalletProfile WHERE status = 'track'").all() as any[];
  let newCount = 0;
  for (const w of tracked) {
    const trades = await adapter.fetchWalletTrades(w.address, since30d());
    for (const t of trades) {
      if (!t.marketId) continue;
      const exists = db.prepare('SELECT 1 FROM ObservedTrade WHERE walletAddress=? AND marketId=? AND timestamp=?').get(t.walletAddress, t.marketId, t.timestamp);
      if (exists) continue;
      let m: any;
      try {
        m = await adapter.fetchMarket(t.marketId);
      } catch (e: any) {
        continue;
      }
      const detectedPrice = t.outcome?.toUpperCase() === 'NO' ? m.noPrice : m.yesPrice;
      db.prepare(
        `INSERT INTO ObservedTrade (walletAddress, marketId, conditionId, marketQuestion, marketCategory, outcome, side, walletEntryPrice, detectedPrice, size, timestamp, rawTradeJson, isDemo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(t.walletAddress, t.marketId, t.conditionId ?? null, t.marketQuestion ?? null, t.marketCategory ?? null, t.outcome ?? null, t.side, t.price, detectedPrice ?? null, t.size, t.timestamp, JSON.stringify(t.raw ?? null), adapter.isDemo ? 1 : 0);
      db.prepare(
        `INSERT INTO MarketSnapshot (marketId, conditionId, question, category, yesPrice, noPrice, bestBid, bestAsk, spread, liquidity, volume, timeToResolution, collectedAt, rawMarketJson, isDemo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(m.marketId, m.conditionId ?? null, m.question ?? null, m.category ?? null, m.yesPrice ?? null, m.noPrice ?? null, m.bestBid ?? null, m.bestAsk ?? null, m.spread ?? null, m.liquidity ?? null, m.volume ?? null, m.timeToResolutionHours ?? null, new Date().toISOString(), JSON.stringify({ ...m, raw: undefined, resolvedOutcome: m.resolvedOutcome }), adapter.isDemo ? 1 : 0);
      newCount++;
    }
  }
  return newCount;
}

/** Score unscored observed trades; journal decisions; open paper trades for copies. */
export async function scoreNewTrades(db: DatabaseSync, adapter: DataAdapter): Promise<{ scored: number; copied: number }> {
  const { rules } = getActiveRules(db);
  const unscored = db.prepare(
    'SELECT ot.* FROM ObservedTrade ot WHERE NOT EXISTS (SELECT 1 FROM DecisionJournal dj WHERE dj.observedTradeId = ot.id)',
  ).all() as any[];
  let copied = 0;
  for (const ot of unscored) {
    const wp = db.prepare('SELECT * FROM WalletProfile WHERE address = ?').get(ot.walletAddress) as any;
    if (!wp || wp.globalScore == null) continue;
    let market: any;
    try { market = await adapter.fetchMarket(ot.marketId); }
    catch { continue; } // market archived or missing — skip scoring
    const trade = {
      walletAddress: ot.walletAddress, marketId: ot.marketId, conditionId: ot.conditionId,
      marketQuestion: ot.marketQuestion, marketCategory: ot.marketCategory, outcome: ot.outcome,
      side: ot.side as 'BUY' | 'SELL', price: ot.walletEntryPrice, size: ot.size, timestamp: ot.timestamp,
    };
    const wallet = {
      globalScore: wp.globalScore, roi30d: wp.roi30d ?? 0, consistencyScore: wp.consistencyScore ?? 0,
      copyabilityScore: wp.copyabilityScore ?? 0, bestCategory: wp.bestCategory,
      categoryStrengths: JSON.parse(wp.categoryStrengthsJson ?? '{}'),
    };
    const d = scoreTrade(trade, market, wallet, rules);
    const res = db.prepare(
      `INSERT INTO DecisionJournal (observedTradeId, walletAddress, marketId, decision, copyScore, confidence, reasonsJson, risksJson,
         walletQualityScore, roiScore, consistencyScore, copyabilityScore, categoryFitScore, entryTimingScore, spreadScore, liquidityScore, thesisScore, simulatedPositionSize, isDemo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      ot.id, ot.walletAddress, ot.marketId, d.decision, d.copyScore, d.confidence, JSON.stringify(d.reasons), JSON.stringify(d.risks),
      d.scores.walletQualityScore, d.scores.roiScore, d.scores.consistencyScore, d.scores.copyabilityScore, d.scores.categoryFitScore,
      d.scores.entryTimingScore, d.scores.spreadScore, d.scores.liquidityScore, d.scores.thesisScore, d.simulatedPositionSize, adapter.isDemo ? 1 : 0,
    );
    if (d.decision === 'paper_copy') {
      createPaperTrade(db, Number(res.lastInsertRowid), trade, market, d, adapter.isDemo);
      copied++;
    }
  }
  return { scored: unscored.length, copied };
}

export { getAdapter };
