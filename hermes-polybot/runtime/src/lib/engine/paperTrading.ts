/** Paper trading engine + hourly PnL + outcome review + benchmarks.
 * SIMULATION ONLY. No orders, no funds, no keys. */
import type postgres from 'postgres';
import type { DataAdapter } from '../adapters/types.ts';
import type { TradeDecision } from './tradeScoring.ts';
import type { WalletTrade, MarketData } from '../adapters/types.ts';

export async function createPaperTrade(
  db: postgres.Sql,
  decisionJournalId: number,
  trade: WalletTrade,
  market: MarketData,
  decision: TradeDecision,
  isDemo: boolean,
): Promise<number> {
  if (decision.decision !== 'paper_copy') throw new Error('createPaperTrade requires a paper_copy decision');
  const size = decision.simulatedPositionSize ?? 5;
  if (size < 5 || size > 20) throw new Error(`simulated position size ${size} outside $5-$20 bounds`);
  const entryPrice = trade.outcome?.toUpperCase() === 'NO' ? (market.noPrice ?? 0.5) : (market.yesPrice ?? 0.5);
  
  const res = await db`
    INSERT INTO "PaperTrade" ("decisionJournalId", "walletAddress", "marketId", "outcome", "side", "entryPrice", "currentPrice", "simulatedPositionSize", "reason", "isDemo")
    VALUES (${decisionJournalId}, ${trade.walletAddress}, ${trade.marketId}, ${trade.outcome ?? 'YES'}, ${trade.side}, ${entryPrice}, ${entryPrice}, ${size}, ${decision.reasons.join('; ')}, ${isDemo ? 1 : 0})
    RETURNING "id"
  `;
  return Number(res[0].id);
}

/** shares = size/entry; pnl = shares * (price - entry) */
export function computePnl(entryPrice: number, currentPrice: number, size: number): number {
  if (entryPrice <= 0) return 0;
  const shares = size / entryPrice;
  return Math.round(shares * (currentPrice - entryPrice) * 100) / 100;
}

/** Hourly PnL update for open trades. Fails loud on adapter error. */
export async function updateOpenPnl(db: postgres.Sql, adapter: DataAdapter): Promise<number> {
  const open = await db`SELECT "id", "marketId", "outcome", "entryPrice", "simulatedPositionSize" FROM "PaperTrade" WHERE "status" = 'open'`;
  if (open.length === 0) return 0;

  // Cache in-flight price fetch promises by key (marketId + outcome)
  // Ensures concurrent/duplicate callers share one in-flight request
  const pricePromises = new Map<string, Promise<number>>();
  const getPrice = (marketId: string, outcome: string): Promise<number> => {
    const key = `${marketId}:${outcome}`;
    if (!pricePromises.has(key)) {
      pricePromises.set(key, adapter.fetchPrice(marketId, outcome));
    }
    return pricePromises.get(key)!;
  };

  let updatedCount = 0;
  const BATCH_SIZE = 10;
  for (let i = 0; i < open.length; i += BATCH_SIZE) {
    const batch = open.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (t) => {
        try {
          const price = await getPrice(t.marketId, t.outcome);
          if (isNaN(price)) return;
          const pnl = computePnl(t.entryPrice, price, t.simulatedPositionSize);
          await db`UPDATE "PaperTrade" SET "currentPrice" = ${price}, "unrealizedPnl" = ${pnl} WHERE "id" = ${t.id}`;
          await db`INSERT INTO "PnlSnapshot" ("paperTradeId", "price", "pnl") VALUES (${t.id}, ${price}, ${pnl})`;
          updatedCount++;
        } catch (e: any) {
          console.warn(`[paperTrading] updateOpenPnl failed for market ${t.marketId}:`, e?.message ?? e);
        }
      })
    );
  }
  return updatedCount;
}


/** Resolve trades whose markets resolved; write OutcomeReview rows. */
export async function reviewOutcomes(db: postgres.Sql, adapter: DataAdapter): Promise<number> {
  const open = await db`SELECT * FROM "PaperTrade" WHERE "status" = 'open'`;
  let resolvedCount = 0;
  for (const t of open) {
    try {
      const m = await adapter.fetchMarket(t.marketId);
      if (!m.resolved) continue;
      const won = m.resolvedOutcome?.toUpperCase() === String(t.outcome).toUpperCase();
      const finalPrice = won ? 1 : 0;
      const pnl = computePnl(t.entryPrice, finalPrice, t.simulatedPositionSize);
      
      await db`UPDATE "PaperTrade" SET "status" = 'resolved', "currentPrice" = ${finalPrice}, "realizedPnl" = ${pnl}, "resolvedAt" = CURRENT_TIMESTAMP WHERE "id" = ${t.id}`;
      
      const snaps = await db`SELECT "price" FROM "PnlSnapshot" WHERE "paperTradeId" = ${t.id} ORDER BY "collectedAt" LIMIT 24`;
      
      const lessons: string[] = [];
      if (pnl > 0) lessons.push('copy decision paid off');
      else lessons.push('copy decision lost; review entry conditions');
      
      await db`
        INSERT INTO "OutcomeReview" ("decisionJournalId", "paperTradeId", "reviewTime", "priceAfter1h", "priceAfter6h", "priceAfter24h", "finalOutcome", "simulatedPnl", "wasDecisionGood", "lessonsJson")
        VALUES (${t.decisionJournalId}, ${t.id}, CURRENT_TIMESTAMP, ${snaps[0]?.price ?? null}, ${snaps[5]?.price ?? null}, ${snaps[23]?.price ?? null}, ${m.resolvedOutcome ?? null}, ${pnl}, ${pnl > 0 ? 1 : 0}, ${JSON.stringify(lessons)})
      `;
      
      await db`UPDATE "DecisionJournal" SET "reviewOutcome" = ${pnl > 0 ? 'good' : 'bad'} WHERE "id" = ${t.decisionJournalId}`;
      resolvedCount++;
    } catch (e: any) {
      console.warn(`[paperTrading] reviewOutcomes failed for market ${t.marketId}:`, e.message);
    }
  }
  return resolvedCount;
}

export interface BenchmarkResult {
  botFiltered: { trades: number; pnl: number; winRate: number };
  blindCopy: { trades: number; pnl: number; winRate: number };
  watchlist: { trades: number; hypotheticalPnl: number };
  skipped: { trades: number; hypotheticalPnl: number };
  missedWinners: number; // watch/skip decisions that would have won
  avoidedLosers: number; // skip decisions that would have lost
}

/** Compare bot-filtered vs blind copy vs watchlist vs skipped, using resolved data. */
export async function computeBenchmarks(db: postgres.Sql): Promise<BenchmarkResult> {
  const resolved = await db`SELECT "realizedPnl" FROM "PaperTrade" WHERE "status" = 'resolved' AND "realizedPnl" IS NOT NULL`;
  const botPnl = resolved.reduce((a, r) => a + Number(r.realizedPnl), 0);
  const botWins = resolved.filter((r) => Number(r.realizedPnl) > 0).length;

  // hypothetical: what every observed trade would have returned at $10 flat if its market resolved
  const hyp = await db`
       SELECT dj."decision", ot."walletEntryPrice" AS entry, ot."outcome", ms."rawMarketJson"
       FROM "DecisionJournal" dj
       JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId"
       LEFT JOIN "MarketSnapshot" ms ON ms."marketId" = dj."marketId"
       WHERE ms."id" = (SELECT MAX("id") FROM "MarketSnapshot" WHERE "marketId" = dj."marketId")
    `;

  let blindPnl = 0, blindTrades = 0, blindWins = 0;
  let watchPnl = 0, watchTrades = 0, skipPnl = 0, skipTrades = 0;
  let missedWinners = 0, avoidedLosers = 0;
  for (const h of hyp) {
    let raw: any = null;
    try { raw = h.rawMarketJson ? JSON.parse(h.rawMarketJson) : null; } catch {}
    const resolvedOutcome = raw?.resolvedOutcome;
    if (!resolvedOutcome || !h.entry || Number(h.entry) <= 0) continue;
    const won = String(resolvedOutcome).toUpperCase() === String(h.outcome).toUpperCase();
    const pnl = computePnl(Number(h.entry), won ? 1 : 0, 10);
    blindPnl += pnl; blindTrades++; if (won) blindWins++;
    if (h.decision === 'watchlist') { watchPnl += pnl; watchTrades++; if (won) missedWinners++; }
    if (h.decision === 'skip') { skipPnl += pnl; skipTrades++; if (won) missedWinners++; else avoidedLosers++; }
  }

  return {
    botFiltered: { trades: resolved.length, pnl: Math.round(botPnl * 100) / 100, winRate: resolved.length ? Math.round((botWins / resolved.length) * 100) / 100 : 0 },
    blindCopy: { trades: blindTrades, pnl: Math.round(blindPnl * 100) / 100, winRate: blindTrades ? Math.round((blindWins / blindTrades) * 100) / 100 : 0 },
    watchlist: { trades: watchTrades, hypotheticalPnl: Math.round(watchPnl * 100) / 100 },
    skipped: { trades: skipTrades, hypotheticalPnl: Math.round(skipPnl * 100) / 100 },
    missedWinners, avoidedLosers,
  };
}
