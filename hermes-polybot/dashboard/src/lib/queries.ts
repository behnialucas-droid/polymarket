/** Read-only dashboard queries. Server-side only with resilient try-catch fallbacks. */
import { getDb } from './db.ts';

function cleanValue(v: any): any {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(cleanValue);
  if (v && typeof v === 'object' && v.constructor === Object) {
    const res: any = {};
    for (const k of Object.keys(v)) res[k] = cleanValue(v[k]);
    return res;
  }
  return v;
}

function cleanRows(rows: any): any {
  if (!rows) return rows;
  if (Array.isArray(rows)) {
    return rows.map(r => cleanValue(typeof r === 'object' && r !== null ? { ...r } : r));
  }
  if (typeof rows === 'object') {
    return cleanValue({ ...rows });
  }
  return rows;
}

export async function hasDemoData(): Promise<boolean> {
  try {
    const sql = getDb();
    const res = await sql`SELECT 1 AS v FROM "WalletProfile" WHERE "isDemo" = 1 LIMIT 1`;
    return res.length > 0;
  } catch {
    return false;
  }
}

export async function overview() {
  const sql = getDb();
  
  const totalPnlRes = await sql`SELECT COALESCE(SUM(COALESCE("realizedPnl", "unrealizedPnl", 0)),0) as v FROM "PaperTrade"`.catch(() => [{ v: 0 }]);
  const resolvedRes = await sql`SELECT "realizedPnl" FROM "PaperTrade" WHERE "status"='resolved' AND "realizedPnl" IS NOT NULL`.catch(() => []);
  const openPositionsRes = await sql`SELECT COUNT(*) as v FROM "PaperTrade" WHERE "status"='open'`.catch(() => [{ v: 0 }]);
  const trackedWalletsRes = await sql`SELECT COUNT(*) as v FROM "WalletProfile" WHERE "status"='track'`.catch(() => [{ v: 0 }]);
  const copyTodayRes = await sql`SELECT COUNT(*) as v FROM "DecisionJournal" WHERE "decision"='paper_copy' AND "createdAt" >= CURRENT_DATE`.catch(() => [{ v: 0 }]);
  const lastReportRes = await sql`SELECT "date", "sentToTelegram" FROM "DailyReport" ORDER BY "date" DESC LIMIT 1`.catch(() => []);
  const ruleChangesRes = await sql`SELECT "reason", "createdAt"::text AS "createdAt" FROM "RuleChange" ORDER BY "id" DESC LIMIT 5`.catch(() => []);
  const pnlSeriesRes = await sql`
    SELECT DATE_TRUNC('hour', "collectedAt")::text as hour, ROUND(SUM("pnl")::numeric, 2) as pnl 
    FROM "PnlSnapshot"
    GROUP BY 1 ORDER BY 1 LIMIT 100
  `.catch(() => []);

  return {
    totalPnl: Number(totalPnlRes[0]?.v ?? 0),
    resolved: cleanRows(resolvedRes),
    openPositions: Number(openPositionsRes[0]?.v ?? 0),
    trackedWallets: Number(trackedWalletsRes[0]?.v ?? 0),
    copyToday: Number(copyTodayRes[0]?.v ?? 0),
    lastReport: cleanRows(lastReportRes[0] || null),
    ruleChanges: cleanRows(ruleChangesRes),
    pnlSeries: cleanRows(pnlSeriesRes),
  };
}

export async function walletRankings() {
  try {
    const sql = getDb();
    const res = await sql`SELECT "address", "label", "sourceRank", "status", "statusReason", "roi30d", "consistencyScore", "copyabilityScore",
              "oneHitWonderPenalty", "globalScore", "bestCategory" FROM "WalletProfile" ORDER BY COALESCE("globalScore", -1) DESC, "sourceRank"`;
    return cleanRows(res);
  } catch {
    return [];
  }
}

export async function walletProfile(address: string) {
  try {
    const sql = getDb();
    const [profile, recentTrades, paperPerf] = await Promise.all([
      sql`SELECT * FROM "WalletProfile" WHERE "address" = ${address}`.catch(() => []),
      sql`SELECT * FROM "ObservedTrade" WHERE "walletAddress" = ${address} ORDER BY "timestamp" DESC LIMIT 20`.catch(() => []),
      sql`SELECT COUNT(*) as n, ROUND(SUM(COALESCE("realizedPnl", "unrealizedPnl", 0))::numeric, 2) as pnl FROM "PaperTrade" WHERE "walletAddress" = ${address}`.catch(() => [{ n: 0, pnl: 0 }])
    ]);
    return {
      profile: cleanRows(profile[0] || null),
      recentTrades: cleanRows(recentTrades),
      paperPerf: cleanRows(paperPerf[0] || null),
    };
  } catch {
    return { profile: null, recentTrades: [], paperPerf: { n: 0, pnl: 0 } };
  }
}

export async function tradeSignals() {
  try {
    const sql = getDb();
    const res = await sql`SELECT dj.*, ot."marketQuestion", ot."walletEntryPrice", ot."detectedPrice", ot."outcome", ot."timestamp",
              ms."spread", ms."liquidity", ms."timeToResolution"
              FROM "DecisionJournal" dj
              JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId"
              LEFT JOIN "MarketSnapshot" ms ON ms."id" = (SELECT MAX("id") FROM "MarketSnapshot" WHERE "marketId" = dj."marketId")
              ORDER BY dj."id" DESC LIMIT 100`;
    return cleanRows(res);
  } catch {
    return [];
  }
}

export async function paperTrades() {
  try {
    const sql = getDb();
    const res = await sql`SELECT pt.*, dj."reasonsJson", ot."marketQuestion" FROM "PaperTrade" pt
              LEFT JOIN "DecisionJournal" dj ON dj."id" = pt."decisionJournalId"
              LEFT JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId"
              ORDER BY pt."id" DESC LIMIT 100`;
    return cleanRows(res);
  } catch {
    return [];
  }
}

export async function decisionJournal() {
  try {
    const sql = getDb();
    const res = await sql`SELECT dj.*, ot."marketQuestion" FROM "DecisionJournal" dj
              LEFT JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId" ORDER BY dj."id" DESC LIMIT 200`;
    return cleanRows(res);
  } catch {
    return [];
  }
}

export async function performance() {
  try {
    const sql = getDb();
    const [overviewData, byCategory, byWallet] = await Promise.all([
      overview(),
      sql`SELECT ot."marketCategory" as cat, COUNT(*) as n, ROUND(SUM(COALESCE(pt."realizedPnl", pt."unrealizedPnl", 0))::numeric, 2) as pnl
          FROM "PaperTrade" pt JOIN "DecisionJournal" dj ON dj."id" = pt."decisionJournalId"
          JOIN "ObservedTrade" ot ON ot."id" = dj."observedTradeId" GROUP BY cat ORDER BY pnl DESC`.catch(() => []),
      sql`SELECT "walletAddress", COUNT(*) as n, ROUND(SUM(COALESCE("realizedPnl", "unrealizedPnl", 0))::numeric, 2) as pnl
          FROM "PaperTrade" GROUP BY "walletAddress" ORDER BY pnl DESC LIMIT 20`.catch(() => [])
    ]);
    
    return {
      pnlSeries: overviewData.pnlSeries,
      byCategory: cleanRows(byCategory),
      byWallet: cleanRows(byWallet),
    };
  } catch {
    return { pnlSeries: [], byCategory: [], byWallet: [] };
  }
}

export async function rulesData() {
  try {
    const sql = getDb();
    const [active, history, changes] = await Promise.all([
      sql`SELECT * FROM "RuleSet" WHERE "active" = 1`.catch(() => []),
      sql`SELECT * FROM "RuleSet" ORDER BY "version" DESC`.catch(() => []),
      sql`SELECT * FROM "RuleChange" ORDER BY "id" DESC LIMIT 50`.catch(() => [])
    ]);
    return {
      active: cleanRows(active[0] || null),
      history: cleanRows(history),
      changes: cleanRows(changes),
    };
  } catch {
    return { active: null, history: [], changes: [] };
  }
}

export async function reportsData() {
  try {
    const sql = getDb();
    const res = await sql`SELECT * FROM "DailyReport" ORDER BY "date" DESC LIMIT 30`;
    return cleanRows(res);
  } catch {
    return [];
  }
}
