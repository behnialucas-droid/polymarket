// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Daily report generation over recorded paper data. */
import type postgres from 'postgres';
import { computeBenchmarks } from './paperTrading.ts';

export interface DailyReportData {
  date: string;
  paperPnlToday: number;
  totalPaperPnl: number;
  winRate: number;
  openPositions: number;
  newSignals: number;
  copiedSignals: number;
  watchedSignals: number;
  skippedSignals: number;
  bestTrade: any;
  worstTrade: any;
  bestWallets: any[];
  worstWallets: any[];
  ruleChanges: any[];
  botBeatBlind: boolean | null;
  topLesson: string;
  summary: string;
}

export async function buildDailyReport(db: postgres.Sql, date: string): Promise<DailyReportData> {
  const today = `${date}%`;
  
  const [
    pnlTodayRes, 
    totalPnlRes, 
    resolved, 
    openPositionsRes, 
    copySigRes, 
    watchSigRes, 
    skipSigRes, 
    bestTrade, 
    worstTrade, 
    bestWallets, 
    worstWallets, 
    ruleChanges, 
    bench, 
    lessons
  ] = await Promise.all([
    db`SELECT COALESCE(SUM("pnl"),0) AS v FROM "PnlSnapshot" WHERE "collectedAt"::text LIKE ${today} AND "id" IN (SELECT MAX("id") FROM "PnlSnapshot" WHERE "collectedAt"::text LIKE ${today} GROUP BY "paperTradeId")`,
    db`SELECT COALESCE(SUM(COALESCE("realizedPnl", "unrealizedPnl", 0)),0) AS v FROM "PaperTrade"`,
    db`SELECT "realizedPnl" FROM "PaperTrade" WHERE "status"='resolved' AND "realizedPnl" IS NOT NULL`,
    db`SELECT COUNT(*) AS v FROM "PaperTrade" WHERE "status"='open'`,
    db`SELECT COUNT(*) AS v FROM "DecisionJournal" WHERE "decision" = 'paper_copy' AND "createdAt"::text LIKE ${today}`,
    db`SELECT COUNT(*) AS v FROM "DecisionJournal" WHERE "decision" = 'watchlist' AND "createdAt"::text LIKE ${today}`,
    db`SELECT COUNT(*) AS v FROM "DecisionJournal" WHERE "decision" = 'skip' AND "createdAt"::text LIKE ${today}`,
    db`SELECT * FROM "PaperTrade" WHERE COALESCE("realizedPnl", "unrealizedPnl") IS NOT NULL ORDER BY COALESCE("realizedPnl", "unrealizedPnl") DESC LIMIT 1`,
    db`SELECT * FROM "PaperTrade" WHERE COALESCE("realizedPnl", "unrealizedPnl") IS NOT NULL ORDER BY COALESCE("realizedPnl", "unrealizedPnl") ASC LIMIT 1`,
    db`SELECT "walletAddress", SUM(COALESCE("realizedPnl", "unrealizedPnl", 0)) AS pnl FROM "PaperTrade" GROUP BY "walletAddress" ORDER BY pnl DESC LIMIT 3`,
    db`SELECT "walletAddress", SUM(COALESCE("realizedPnl", "unrealizedPnl", 0)) AS pnl FROM "PaperTrade" GROUP BY "walletAddress" ORDER BY pnl ASC LIMIT 3`,
    db`SELECT "reason", "beforeJson", "afterJson", "createdAt" FROM "RuleChange" WHERE "createdAt"::text LIKE ${today}`,
    computeBenchmarks(db),
    db`SELECT "lessonsJson" FROM "OutcomeReview" WHERE "createdAt"::text LIKE ${today} ORDER BY "id" DESC LIMIT 1`
  ]);

  const pnlToday = Number(pnlTodayRes[0]?.v ?? 0);
  const totalPnl = Number(totalPnlRes[0]?.v ?? 0);
  const winRate = resolved.length ? resolved.filter((r) => Number(r.realizedPnl) > 0).length / resolved.length : 0;
  const openPositions = Number(openPositionsRes[0]?.v ?? 0);
  
  const copiedSignals = Number(copySigRes[0]?.v ?? 0);
  const watchedSignals = Number(watchSigRes[0]?.v ?? 0);
  const skippedSignals = Number(skipSigRes[0]?.v ?? 0);
  const newSignals = copiedSignals + watchedSignals + skippedSignals;

  const botBeatBlind = bench.blindCopy.trades > 0 ? bench.botFiltered.pnl > bench.blindCopy.pnl : null;
  
  let topLesson = 'no resolved outcomes today';
  try { topLesson = JSON.parse(lessons[0]?.lessonsJson ?? '[]')[0] ?? topLesson; } catch {}

  const summary = [
    `Paper PnL today: $${pnlToday.toFixed(2)} | total: $${totalPnl.toFixed(2)} | win rate: ${(winRate * 100).toFixed(0)}%`,
    `Open positions: ${openPositions} | signals: ${copiedSignals} copied, ${watchedSignals} watched, ${skippedSignals} skipped`,
    `Rule changes today: ${ruleChanges.length}`,
    botBeatBlind === null ? 'Benchmark: not enough resolved data' : botBeatBlind ? 'Bot-filtered BEAT blind copy today' : 'Bot-filtered did NOT beat blind copy today',
    `Top lesson: ${topLesson}`,
  ].join('\n');

  return {
    date, paperPnlToday: pnlToday, totalPaperPnl: totalPnl, winRate: Math.round(winRate * 100) / 100,
    openPositions, newSignals, copiedSignals, watchedSignals, skippedSignals,
    bestTrade: bestTrade[0] || null, worstTrade: worstTrade[0] || null, bestWallets, worstWallets, ruleChanges, botBeatBlind, topLesson, summary,
  };
}

export async function saveDailyReport(db: postgres.Sql, r: DailyReportData, sentToTelegram: boolean, isDemo: boolean): Promise<void> {
  await db`
    INSERT INTO "DailyReport" ("date", "paperPnl", "winRate", "openPositions", "newSignals", "copiedSignals", "watchedSignals", "skippedSignals", "bestWalletsJson", "worstWalletsJson", "ruleChangesJson", "summary", "sentToTelegram", "isDemo")
    VALUES (${r.date}, ${r.paperPnlToday}, ${r.winRate}, ${r.openPositions}, ${r.newSignals}, ${r.copiedSignals}, ${r.watchedSignals}, ${r.skippedSignals}, ${JSON.stringify(r.bestWallets)}, ${JSON.stringify(r.worstWallets)}, ${JSON.stringify(r.ruleChanges)}, ${r.summary}, ${sentToTelegram ? 1 : 0}, ${isDemo ? 1 : 0})
    ON CONFLICT("date") DO UPDATE SET "paperPnl"=EXCLUDED."paperPnl", "winRate"=EXCLUDED."winRate", "openPositions"=EXCLUDED."openPositions",
      "newSignals"=EXCLUDED."newSignals", "copiedSignals"=EXCLUDED."copiedSignals", "watchedSignals"=EXCLUDED."watchedSignals", "skippedSignals"=EXCLUDED."skippedSignals",
      "bestWalletsJson"=EXCLUDED."bestWalletsJson", "worstWalletsJson"=EXCLUDED."worstWalletsJson", "ruleChangesJson"=EXCLUDED."ruleChangesJson",
      "summary"=EXCLUDED."summary", "sentToTelegram"=EXCLUDED."sentToTelegram"
  `;
}