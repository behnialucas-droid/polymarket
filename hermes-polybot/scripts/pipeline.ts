/** Pipeline steps shared by scripts. Fail loud: adapter errors propagate. */
import type postgres from 'postgres';
import { getAdapter, type DataAdapter } from '../src/lib/adapters/index.ts';
import { scoreWallet, walletStatus, type TradeWithMarket } from '../src/lib/engine/walletScoring.ts';
import { scoreTrade } from '../src/lib/engine/tradeScoring.ts';
import { createPaperTrade } from '../src/lib/engine/paperTrading.ts';
import { getActiveRules } from '../src/lib/engine/rules.ts';

export function since30d(): string {
  return new Date(Date.now() - 30 * 864e5).toISOString();
}

export async function runLeaderboardScan(db: postgres.Sql, adapter: DataAdapter, limit = 500): Promise<number> {
  const entries = await adapter.fetchLeaderboard(limit);
  await db`
    INSERT INTO "LeaderboardScan" ("source", "scannedAt", "walletCount", "lookbackDays", "rawSummaryJson", "isDemo") 
    VALUES (${adapter.source}, CURRENT_TIMESTAMP, ${entries.length}, 30, ${JSON.stringify(entries.slice(0, 50))}, ${adapter.isDemo ? 1 : 0})
  `;
  for (const e of entries) {
    await db`
      INSERT INTO "WalletProfile" ("address", "label", "sourceRank", "isDemo") 
      VALUES (${e.address}, ${e.label ?? null}, ${e.rank}, ${adapter.isDemo ? 1 : 0})
      ON CONFLICT("address") DO UPDATE SET "label"=EXCLUDED."label", "sourceRank"=EXCLUDED."sourceRank", "updatedAt"=CURRENT_TIMESTAMP
    `;
  }
  return entries.length;
}

export async function profileWallet(db: postgres.Sql, adapter: DataAdapter, address: string): Promise<void> {
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
      const won = String(m.resolvedOutcome).toUpperCase() === String(t.outcome).toUpperCase();
      pnlPerDollar = ((won ? 1 : 0) - t.price) / t.price;
    }
    items.push({ trade: t, market: m, pnlPerDollar });
  }
  const s = scoreWallet(items);
  const { rules } = await getActiveRules(db);
  const st = walletStatus(s, rules.minWalletGlobalScore);
  
  await db`
    UPDATE "WalletProfile" SET 
      "status"=${st.status}, "statusReason"=${st.reason}, "roi30d"=${s.roi30d}, "consistencyScore"=${s.consistencyScore}, 
      "copyabilityScore"=${s.copyabilityScore}, "oneHitWonderPenalty"=${s.oneHitWonderPenalty}, "globalScore"=${s.globalScore},
      "bestCategory"=${s.bestCategory}, "categoryStrengthsJson"=${JSON.stringify(s.categoryStrengths)}, "averageTradeSize"=${s.averageTradeSize}, 
      "tradeCount30d"=${s.tradeCount30d}, "resolvedTradeCount30d"=${s.resolvedTradeCount30d}, "winRate30d"=${s.winRate30d},
      "averageLiquidity"=${s.averageLiquidity}, "averageSpread"=${s.averageSpread}, "averageEntryTiming"=${s.averageEntryTiming}, 
      "copyabilityNotes"=${s.copyabilityNotes}, "riskNotes"=${s.riskNotes}, "lastScannedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
    WHERE "address"=${address}
  `;
}

/** Detect trades from tracked wallets not yet observed; store them + market snapshots. */
export async function monitorTrades(db: postgres.Sql, adapter: DataAdapter): Promise<number> {
  const tracked = await db`SELECT "address" FROM "WalletProfile" WHERE "status" = 'track'`;
  let newCount = 0;
  for (const w of tracked) {
    const trades = await adapter.fetchWalletTrades(w.address, since30d());
    for (const t of trades) {
      if (!t.marketId) continue;
      const exists = await db`SELECT 1 FROM "ObservedTrade" WHERE "walletAddress"=${t.walletAddress} AND "marketId"=${t.marketId} AND "timestamp"=${t.timestamp}`;
      if (exists.length > 0) continue;
      
      let m: any;
      try {
        m = await adapter.fetchMarket(t.marketId);
      } catch (e: any) {
        continue;
      }
      const detectedPrice = t.outcome?.toUpperCase() === 'NO' ? m.noPrice : m.yesPrice;
      
      await db`
        INSERT INTO "ObservedTrade" ("walletAddress", "marketId", "conditionId", "marketQuestion", "marketCategory", "outcome", "side", "walletEntryPrice", "detectedPrice", "size", "timestamp", "rawTradeJson", "isDemo")
        VALUES (${t.walletAddress}, ${t.marketId}, ${t.conditionId ?? null}, ${t.marketQuestion ?? null}, ${t.marketCategory ?? null}, ${t.outcome ?? null}, ${t.side}, ${t.price}, ${detectedPrice ?? null}, ${t.size}, ${t.timestamp}, ${JSON.stringify(t.raw ?? null)}, ${adapter.isDemo ? 1 : 0})
      `;
      
      await db`
        INSERT INTO "MarketSnapshot" ("marketId", "conditionId", "question", "category", "yesPrice", "noPrice", "bestBid", "bestAsk", "spread", "liquidity", "volume", "timeToResolution", "collectedAt", "rawMarketJson", "isDemo")
        VALUES (${m.marketId}, ${m.conditionId ?? null}, ${m.question ?? null}, ${m.category ?? null}, ${m.yesPrice ?? null}, ${m.noPrice ?? null}, ${m.bestBid ?? null}, ${m.bestAsk ?? null}, ${m.spread ?? null}, ${m.liquidity ?? null}, ${m.volume ?? null}, ${m.timeToResolutionHours ?? null}, CURRENT_TIMESTAMP, ${JSON.stringify({ ...m, raw: undefined, resolvedOutcome: m.resolvedOutcome })}, ${adapter.isDemo ? 1 : 0})
      `;
      newCount++;
    }
  }
  return newCount;
}

/** Score unscored observed trades; journal decisions; open paper trades for copies. */
export async function scoreNewTrades(db: postgres.Sql, adapter: DataAdapter): Promise<{ scored: number; copied: number }> {
  const { rules } = await getActiveRules(db);
  const unscored = await db`
    SELECT ot.* FROM "ObservedTrade" ot WHERE NOT EXISTS (SELECT 1 FROM "DecisionJournal" dj WHERE dj."observedTradeId" = ot."id")
  `;
  let copied = 0;
  for (const ot of unscored) {
    const wpList = await db`SELECT * FROM "WalletProfile" WHERE "address" = ${ot.walletAddress}`;
    const wp = wpList[0];
    if (!wp || wp.globalScore == null) continue;
    let market: any;
    try { market = await adapter.fetchMarket(ot.marketId); }
    catch { continue; } // market archived or missing — skip scoring
    const trade = {
      walletAddress: ot.walletAddress, marketId: ot.marketId, conditionId: ot.conditionId,
      marketQuestion: ot.marketQuestion, marketCategory: ot.marketCategory, outcome: ot.outcome,
      side: ot.side as 'BUY' | 'SELL', price: Number(ot.walletEntryPrice), size: Number(ot.size), timestamp: ot.timestamp,
    };
    const wallet = {
      globalScore: Number(wp.globalScore), roi30d: Number(wp.roi30d ?? 0), consistencyScore: Number(wp.consistencyScore ?? 0),
      copyabilityScore: Number(wp.copyabilityScore ?? 0), bestCategory: wp.bestCategory,
      categoryStrengths: JSON.parse(wp.categoryStrengthsJson ?? '{}'),
    };
    const d = scoreTrade(trade, market, wallet, rules);
    
    const res = await db`
      INSERT INTO "DecisionJournal" ("observedTradeId", "walletAddress", "marketId", "decision", "copyScore", "confidence", "reasonsJson", "risksJson",
         "walletQualityScore", "roiScore", "consistencyScore", "copyabilityScore", "categoryFitScore", "entryTimingScore", "spreadScore", "liquidityScore", "thesisScore", "simulatedPositionSize", "isDemo")
      VALUES (${ot.id}, ${ot.walletAddress}, ${ot.marketId}, ${d.decision}, ${d.copyScore}, ${d.confidence}, ${JSON.stringify(d.reasons)}, ${JSON.stringify(d.risks)},
      ${d.scores.walletQualityScore}, ${d.scores.roiScore}, ${d.scores.consistencyScore}, ${d.scores.copyabilityScore}, ${d.scores.categoryFitScore},
      ${d.scores.entryTimingScore}, ${d.scores.spreadScore}, ${d.scores.liquidityScore}, ${d.scores.thesisScore}, ${d.simulatedPositionSize}, ${adapter.isDemo ? 1 : 0})
      RETURNING "id"
    `;
    
    if (d.decision === 'paper_copy') {
      await createPaperTrade(db, Number(res[0].id), trade, market, d, adapter.isDemo);
      copied++;
    }
  }
  return { scored: unscored.length, copied };
}

export { getAdapter };
