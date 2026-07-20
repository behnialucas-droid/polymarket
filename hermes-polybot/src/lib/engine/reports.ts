/** Daily report generation + optional Telegram send (env-gated, token redacted). */
import type { DatabaseSync } from 'node:sqlite';
import { computeBenchmarks } from './paperTrading.ts';
import { redact } from '../env.ts';

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

export function buildDailyReport(db: DatabaseSync, date: string): DailyReportData {
  const today = `${date}%`;
  const q = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
  const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;

  const pnlToday = one("SELECT COALESCE(SUM(pnl),0) AS v FROM PnlSnapshot WHERE collectedAt LIKE ? AND id IN (SELECT MAX(id) FROM PnlSnapshot WHERE collectedAt LIKE ? GROUP BY paperTradeId)", today, today)?.v ?? 0;
  const totalPnl = one("SELECT COALESCE(SUM(COALESCE(realizedPnl, unrealizedPnl, 0)),0) AS v FROM PaperTrade")?.v ?? 0;
  const resolved = q("SELECT realizedPnl FROM PaperTrade WHERE status='resolved' AND realizedPnl IS NOT NULL");
  const winRate = resolved.length ? resolved.filter((r) => r.realizedPnl > 0).length / resolved.length : 0;
  const openPositions = one("SELECT COUNT(*) AS v FROM PaperTrade WHERE status='open'")?.v ?? 0;
  const sig = (d: string) => one('SELECT COUNT(*) AS v FROM DecisionJournal WHERE decision = ? AND createdAt LIKE ?', d, today)?.v ?? 0;
  const bestTrade = one("SELECT * FROM PaperTrade WHERE COALESCE(realizedPnl, unrealizedPnl) IS NOT NULL ORDER BY COALESCE(realizedPnl, unrealizedPnl) DESC LIMIT 1");
  const worstTrade = one("SELECT * FROM PaperTrade WHERE COALESCE(realizedPnl, unrealizedPnl) IS NOT NULL ORDER BY COALESCE(realizedPnl, unrealizedPnl) ASC LIMIT 1");
  const bestWallets = q("SELECT walletAddress, SUM(COALESCE(realizedPnl, unrealizedPnl, 0)) AS pnl FROM PaperTrade GROUP BY walletAddress ORDER BY pnl DESC LIMIT 3");
  const worstWallets = q("SELECT walletAddress, SUM(COALESCE(realizedPnl, unrealizedPnl, 0)) AS pnl FROM PaperTrade GROUP BY walletAddress ORDER BY pnl ASC LIMIT 3");
  const ruleChanges = q('SELECT reason, beforeJson, afterJson, createdAt FROM RuleChange WHERE createdAt LIKE ?', today);
  const bench = computeBenchmarks(db);
  const botBeatBlind = bench.blindCopy.trades > 0 ? bench.botFiltered.pnl > bench.blindCopy.pnl : null;
  const lessons = q("SELECT lessonsJson FROM OutcomeReview WHERE createdAt LIKE ? ORDER BY id DESC LIMIT 1", today);
  let topLesson = 'no resolved outcomes today';
  try { topLesson = JSON.parse(lessons[0]?.lessonsJson ?? '[]')[0] ?? topLesson; } catch {}

  const summary = [
    `Paper PnL today: $${Number(pnlToday).toFixed(2)} | total: $${Number(totalPnl).toFixed(2)} | win rate: ${(winRate * 100).toFixed(0)}%`,
    `Open positions: ${openPositions} | signals: ${sig('paper_copy')} copied, ${sig('watchlist')} watched, ${sig('skip')} skipped`,
    `Rule changes today: ${ruleChanges.length}`,
    botBeatBlind === null ? 'Benchmark: not enough resolved data' : botBeatBlind ? 'Bot-filtered BEAT blind copy today' : 'Bot-filtered did NOT beat blind copy today',
    `Top lesson: ${topLesson}`,
  ].join('\n');

  return {
    date, paperPnlToday: pnlToday, totalPaperPnl: totalPnl, winRate: Math.round(winRate * 100) / 100,
    openPositions, newSignals: sig('paper_copy') + sig('watchlist') + sig('skip'),
    copiedSignals: sig('paper_copy'), watchedSignals: sig('watchlist'), skippedSignals: sig('skip'),
    bestTrade, worstTrade, bestWallets, worstWallets, ruleChanges, botBeatBlind, topLesson, summary,
  };
}

export function saveDailyReport(db: DatabaseSync, r: DailyReportData, sentToTelegram: boolean, isDemo: boolean): void {
  db.prepare(
    `INSERT INTO DailyReport (date, paperPnl, winRate, openPositions, newSignals, copiedSignals, watchedSignals, skippedSignals, bestWalletsJson, worstWalletsJson, ruleChangesJson, summary, sentToTelegram, isDemo)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET paperPnl=excluded.paperPnl, winRate=excluded.winRate, openPositions=excluded.openPositions,
       newSignals=excluded.newSignals, copiedSignals=excluded.copiedSignals, watchedSignals=excluded.watchedSignals, skippedSignals=excluded.skippedSignals,
       bestWalletsJson=excluded.bestWalletsJson, worstWalletsJson=excluded.worstWalletsJson, ruleChangesJson=excluded.ruleChangesJson,
       summary=excluded.summary, sentToTelegram=excluded.sentToTelegram`,
  ).run(
    r.date, r.paperPnlToday, r.winRate, r.openPositions, r.newSignals, r.copiedSignals, r.watchedSignals, r.skippedSignals,
    JSON.stringify(r.bestWallets), JSON.stringify(r.worstWallets), JSON.stringify(r.ruleChanges), r.summary, sentToTelegram ? 1 : 0, isDemo ? 1 : 0,
  );
}

/** Send via Telegram if configured; otherwise print. Never logs the token. */
export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[telegram not configured — printing report]\n' + redact(text));
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(redact(`Telegram send failed: HTTP ${res.status} ${body.slice(0, 300)}`));
  }
  return true;
}
