/** Read-only dashboard queries. Server-side only. */
import { getDb } from './db.ts';

export async function hasDemoData(): Promise<boolean> {
  const sql = getDb();
  const res = await sql`SELECT 1 AS v FROM "WalletProfile" WHERE "isDemo" = 1 LIMIT 1`;
  return res.length > 0;
}

export async function overview() {
  const sql = getDb();
  const [totalPnlRes, resolvedRes, openPositionsRes, trackedWalletsRes, copyTodayRes, lastReportRes, ruleChangesRes, pnlSeriesRes] = await Promise.all([
    sql`SELECT COALESCE(SUM(COALESCE("realizedPnl", "unrealizedPnl", 0)),0) as v FROM "PaperTrade"`,
    sql`SELECT "realizedPnl" FROM "PaperTrade" WHERE "status"='resolved' AND "realizedPnl" IS NOT NULL`,
    sql`SELECT COUNT(*) as v FROM "PaperTrade" WHERE "status"='open'`,
    sql`SELECT COUNT(*) as v FROM "WalletProfile" WHERE "status"='track'`,
    sql`SELECT COUNT(*) as v FROM "DecisionJournal" WHERE "decision"='paper_copy' AND DATE("createdAt")=CURRENT_DATE`,
    sql`SELECT "date", "sentToTelegram" FROM "DailyReport" ORDER BY "date" DESC LIMIT 1`,
    sql`SELECT "reason", "createdAt" FROM "RuleChange" ORDER BY "id" DESC LIMIT 5`,
    sql`SELECT SUBSTR("collectedAt"::text, 1, 13) as hour, ROUND(SUM("pnl")::numeric, 2) as pnl FROM "PnlSnapshot"
        WHERE "id" IN (SELECT MAX("id") FROM "PnlSnapshot" GROUP BY "paperTradeId", SUBSTR("collectedAt"::text, 1, 13))
        GROUP BY hour ORDER BY hour`
  ]);

  return {
    totalPnl: totalPnlRes[0]?.v ?? 0,
    resolved: resolvedRes,
    openPositions: openPositionsRes[0]?.v ?? 0,
    trackedWallets: trackedWalletsRes[0]?.v ?? 0,
    copyToday: copyTodayRes[0]?.v ?? 0,
    lastReport: lastReportRes[0] || null,
    ruleChanges: ruleChangesRes,
    pnlSeries: pnlSeriesRes,
  };
}

export async function walletRankings() {
  const sql = getDb();
  return await sql`SELECT "address", "label", "sourceRank", "status", "statusReason", "roi30d", "consistencyScore", "copyabilityScore",
            "oneHitWonderPenalty", "globalScore", "bestCategory" FROM "WalletProfile" ORDER BY COALESCE("globalScore", -1) DESC, "sourceRank"`;
}

export async function walletProfile(address: string) {
  const sql = getDb();
  const [profile, recentTrades, paperPerf] = await Promise.all([
    sql`SELECT * FROM "WalletProfile" WHERE "address" = ${address}`,
    sql`SELECT * FROM "ObservedTrade" WHERE "walletAddress" = ${address} ORDER BY "timestamp" DESC LIMIT 20`,
    sql`SELECT COUNT(*) as n, ROUND(SUM(COALESCE("realizedPnl", "unrealizedPnl", 0))::numeric, 2) as pnl FROM "PaperTrade" WHERE "walletAddress" = ${address}`
  ]);
  return {
    profile: profile[0] || null,
    recentTrades,
    paperPerf: paperPerf[0] || null,
  };
}

export async function tradeSignals() {
  const sql = getDb();
  return await sql`SELECT dj.*, ot."marketQuestion", ot."walletEntryPrice", ot."detectedPrice", ot."outcome", ot."timestamp",
            ms."spread", ms."liquidity", ms."timeToResolution"
            FROM "DecisionJournal" dj
            JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId"
            LEFT JOIN "MarketSnapshot" ms ON ms."id" = (SELECT MAX("id") FROM "MarketSnapshot" WHERE "marketId" = dj."marketId")
            ORDER BY dj."id" DESC LIMIT 100`;
}

export async function paperTrades() {
  const sql = getDb();
  return await sql`SELECT pt.*, dj."reasonsJson", ot."marketQuestion" FROM "PaperTrade" pt
            LEFT JOIN "DecisionJournal" dj ON dj."id" = pt."decisionJournalId"
            LEFT JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId"
            ORDER BY pt."id" DESC LIMIT 100`;
}

export async function decisionJournal() {
  const sql = getDb();
  return await sql`SELECT dj.*, ot."marketQuestion" FROM "DecisionJournal" dj
            LEFT JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId" ORDER BY dj."id" DESC LIMIT 200`;
}

export async function performance() {
  const sql = getDb();
  const [overviewData, byCategory, byWallet] = await Promise.all([
    overview(),
    sql`SELECT ot."marketCategory" as cat, COUNT(*) as n, ROUND(SUM(COALESCE(pt."realizedPnl", pt."unrealizedPnl", 0))::numeric, 2) as pnl
        FROM "PaperTrade" pt JOIN "DecisionJournal" dj ON dj."id" = pt."decisionJournalId"
        JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId" GROUP BY cat ORDER BY pnl DESC`,
    sql`SELECT "walletAddress", COUNT(*) as n, ROUND(SUM(COALESCE("realizedPnl", "unrealizedPnl", 0))::numeric, 2) as pnl
        FROM "PaperTrade" GROUP BY "walletAddress" ORDER BY pnl DESC LIMIT 20`
  ]);
  
  return {
    pnlSeries: overviewData.pnlSeries,
    byCategory,
    byWallet,
  };
}

export async function rulesData() {
  const sql = getDb();
  const [active, history, changes] = await Promise.all([
    sql`SELECT * FROM "RuleSet" WHERE "active" = 1`,
    sql`SELECT * FROM "RuleSet" ORDER BY "version" DESC`,
    sql`SELECT * FROM "RuleChange" ORDER BY "id" DESC LIMIT 50`
  ]);
  return {
    active: active[0] || null,
    history,
    changes,
  };
}

export async function reportsData() {
  const sql = getDb();
  return await sql`SELECT * FROM "DailyReport" ORDER BY "date" DESC LIMIT 30`;
}
