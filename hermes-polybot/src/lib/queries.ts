/** Read-only dashboard queries. Server-side only. */
import { getDb } from './db.ts';

// node:sqlite rows are null-prototype objects; convert so they can cross the RSC boundary
const plain = (r: any) => (r ? { ...r } : r);
const q = (sql: string, ...p: any[]) => (getDb().prepare(sql).all(...p) as any[]).map(plain);
const one = (sql: string, ...p: any[]) => plain(getDb().prepare(sql).get(...p));

export function hasDemoData(): boolean {
  return Boolean(one('SELECT 1 AS v FROM WalletProfile WHERE isDemo = 1 LIMIT 1'));
}

export function overview() {
  return {
    totalPnl: one('SELECT COALESCE(SUM(COALESCE(realizedPnl, unrealizedPnl, 0)),0) v FROM PaperTrade')?.v ?? 0,
    resolved: q("SELECT realizedPnl FROM PaperTrade WHERE status='resolved' AND realizedPnl IS NOT NULL"),
    openPositions: one("SELECT COUNT(*) v FROM PaperTrade WHERE status='open'")?.v ?? 0,
    trackedWallets: one("SELECT COUNT(*) v FROM WalletProfile WHERE status='track'")?.v ?? 0,
    copyToday: one("SELECT COUNT(*) v FROM DecisionJournal WHERE decision='paper_copy' AND date(createdAt)=date('now')")?.v ?? 0,
    lastReport: one('SELECT date, sentToTelegram FROM DailyReport ORDER BY date DESC LIMIT 1'),
    ruleChanges: q('SELECT reason, createdAt FROM RuleChange ORDER BY id DESC LIMIT 5'),
    pnlSeries: q(`SELECT substr(collectedAt, 1, 13) hour, ROUND(SUM(pnl),2) pnl FROM PnlSnapshot
                  WHERE id IN (SELECT MAX(id) FROM PnlSnapshot GROUP BY paperTradeId, substr(collectedAt,1,13))
                  GROUP BY hour ORDER BY hour`),
  };
}

export function walletRankings() {
  return q(`SELECT address, label, sourceRank, status, statusReason, roi30d, consistencyScore, copyabilityScore,
            oneHitWonderPenalty, globalScore, bestCategory FROM WalletProfile ORDER BY COALESCE(globalScore, -1) DESC, sourceRank`);
}

export function walletProfile(address: string) {
  return {
    profile: one('SELECT * FROM WalletProfile WHERE address = ?', address),
    recentTrades: q('SELECT * FROM ObservedTrade WHERE walletAddress = ? ORDER BY timestamp DESC LIMIT 20', address),
    paperPerf: one("SELECT COUNT(*) n, ROUND(SUM(COALESCE(realizedPnl, unrealizedPnl, 0)),2) pnl FROM PaperTrade WHERE walletAddress = ?", address),
  };
}

export function tradeSignals() {
  return q(`SELECT dj.*, ot.marketQuestion, ot.walletEntryPrice, ot.detectedPrice, ot.outcome, ot.timestamp,
            ms.spread, ms.liquidity, ms.timeToResolution
            FROM DecisionJournal dj
            JOIN ObservedTrade ot ON ot.id = dj.observedTradeId
            LEFT JOIN MarketSnapshot ms ON ms.id = (SELECT MAX(id) FROM MarketSnapshot WHERE marketId = dj.marketId)
            ORDER BY dj.id DESC LIMIT 100`);
}

export function paperTrades() {
  return q(`SELECT pt.*, dj.reasonsJson, ot.marketQuestion FROM PaperTrade pt
            LEFT JOIN DecisionJournal dj ON dj.id = pt.decisionJournalId
            LEFT JOIN ObservedTrade ot ON ot.id = dj.observedTradeId
            ORDER BY pt.id DESC LIMIT 100`);
}

export function decisionJournal() {
  return q(`SELECT dj.*, ot.marketQuestion FROM DecisionJournal dj
            LEFT JOIN ObservedTrade ot ON ot.id = dj.observedTradeId ORDER BY dj.id DESC LIMIT 200`);
}

export function performance() {
  return {
    pnlSeries: overview().pnlSeries,
    byCategory: q(`SELECT ot.marketCategory cat, COUNT(*) n, ROUND(SUM(COALESCE(pt.realizedPnl, pt.unrealizedPnl, 0)),2) pnl
                   FROM PaperTrade pt JOIN DecisionJournal dj ON dj.id = pt.decisionJournalId
                   JOIN ObservedTrade ot ON ot.id = dj.observedTradeId GROUP BY cat ORDER BY pnl DESC`),
    byWallet: q(`SELECT walletAddress, COUNT(*) n, ROUND(SUM(COALESCE(realizedPnl, unrealizedPnl, 0)),2) pnl
                 FROM PaperTrade GROUP BY walletAddress ORDER BY pnl DESC LIMIT 20`),
  };
}

export function rulesData() {
  return {
    active: one('SELECT * FROM RuleSet WHERE active = 1'),
    history: q('SELECT * FROM RuleSet ORDER BY version DESC'),
    changes: q('SELECT * FROM RuleChange ORDER BY id DESC LIMIT 50'),
  };
}

export function reportsData() {
  return q('SELECT * FROM DailyReport ORDER BY date DESC LIMIT 30');
}
