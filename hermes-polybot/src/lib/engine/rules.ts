/** Versioned rule sets + automatic rule changes with full audit trail. */
import type { DatabaseSync } from 'node:sqlite';

export interface Rules {
  minLiquidity: number;
  maxSpread: number;
  maxPriceMoveSinceEntry: number; // absolute price move allowed after wallet entry
  minWalletGlobalScore: number;
  minCopyScore: number; // threshold for paper_copy
  minWatchScore: number; // threshold for watchlist
  minResolvedTrades: number;
  maxTimeToResolutionHours: number;
  weights: {
    roi: number;
    consistency: number;
    copyability: number;
    categoryFit: number;
    entryTiming: number;
    spread: number;
    liquidity: number;
    thesis: number;
  };
}

export const DEFAULT_RULES: Rules = {
  minLiquidity: 1000,
  maxSpread: 0.05,
  maxPriceMoveSinceEntry: 0.07,
  minWalletGlobalScore: 0.5,
  minCopyScore: 0.65,
  minWatchScore: 0.45,
  minResolvedTrades: 5,
  maxTimeToResolutionHours: 24 * 60,
  weights: { roi: 0.2, consistency: 0.15, copyability: 0.15, categoryFit: 0.1, entryTiming: 0.1, spread: 0.1, liquidity: 0.1, thesis: 0.1 },
};

export function getActiveRules(db: DatabaseSync): { rules: Rules; version: number; id: number } {
  const row = db.prepare('SELECT id, version, rulesJson FROM RuleSet WHERE active = 1 ORDER BY version DESC LIMIT 1').get() as any;
  if (!row) {
    const res = db.prepare('INSERT INTO RuleSet (version, active, rulesJson) VALUES (1, 1, ?)').run(JSON.stringify(DEFAULT_RULES));
    return { rules: { ...DEFAULT_RULES }, version: 1, id: Number(res.lastInsertRowid) };
  }
  return { rules: JSON.parse(row.rulesJson), version: row.version, id: row.id };
}

export interface RuleChangeInput {
  reason: string;
  evidenceSummary: string;
  expectedImprovement: string;
  mutate: (r: Rules) => void;
}

/** Apply a rule change: new versioned RuleSet + RuleChange audit row. */
export function applyRuleChange(db: DatabaseSync, change: RuleChangeInput): { newVersion: number } {
  const cur = getActiveRules(db);
  const next: Rules = JSON.parse(JSON.stringify(cur.rules));
  change.mutate(next);
  const before = JSON.stringify(cur.rules);
  const after = JSON.stringify(next);
  if (before === after) return { newVersion: cur.version };
  const newVersion = cur.version + 1;
  db.prepare('UPDATE RuleSet SET active = 0 WHERE active = 1').run();
  const res = db.prepare('INSERT INTO RuleSet (version, active, rulesJson) VALUES (?, 1, ?)').run(newVersion, after);
  db.prepare(
    'INSERT INTO RuleChange (oldRuleSetId, newRuleSetId, changedBy, reason, evidenceSummary, beforeJson, afterJson, expectedImprovement) VALUES (?,?,?,?,?,?,?,?)',
  ).run(cur.id, Number(res.lastInsertRowid), 'hermes', change.reason, change.evidenceSummary, before, after, change.expectedImprovement);
  return { newVersion };
}

/** Self-improvement: inspect outcome reviews + paper results, adjust thresholds.
 * Returns list of changes made (each already logged with evidence). */
export function autoUpdateRules(db: DatabaseSync): string[] {
  const changes: string[] = [];
  const { rules } = getActiveRules(db);

  // Evidence: performance of resolved paper trades bucketed by conditions at decision time
  const rows = db
    .prepare(
      `SELECT pt.realizedPnl AS pnl, dj.spreadScore, dj.liquidityScore, dj.entryTimingScore
       FROM PaperTrade pt JOIN DecisionJournal dj ON dj.id = pt.decisionJournalId
       WHERE pt.status = 'resolved' AND pt.realizedPnl IS NOT NULL`,
    )
    .all() as any[];
  if (rows.length < 5) return changes; // not enough evidence

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const wideSpread = rows.filter((r) => (r.spreadScore ?? 1) < 0.5);
  const lowLiq = rows.filter((r) => (r.liquidityScore ?? 1) < 0.5);
  const late = rows.filter((r) => (r.entryTimingScore ?? 1) < 0.5);

  if (wideSpread.length >= 3 && avg(wideSpread.map((r) => r.pnl)) < 0) {
    const oldV = rules.maxSpread;
    applyRuleChange(db, {
      reason: 'Spread-heavy trades underperform; tighten max spread',
      evidenceSummary: `${wideSpread.length} resolved trades with low spread score averaged ${avg(wideSpread.map((r) => r.pnl)).toFixed(2)} PnL`,
      expectedImprovement: 'Fewer spread losses',
      mutate: (r) => { r.maxSpread = Math.max(0.01, Math.round(r.maxSpread * 0.8 * 100) / 100); },
    });
    changes.push(`maxSpread ${oldV} -> tightened`);
  }
  if (lowLiq.length >= 3 && avg(lowLiq.map((r) => r.pnl)) < 0) {
    const oldV = rules.minLiquidity;
    applyRuleChange(db, {
      reason: 'Low-liquidity trades perform poorly; raise minimum liquidity',
      evidenceSummary: `${lowLiq.length} resolved trades with low liquidity score averaged ${avg(lowLiq.map((r) => r.pnl)).toFixed(2)} PnL`,
      expectedImprovement: 'Avoid unfillable copies',
      mutate: (r) => { r.minLiquidity = Math.round(r.minLiquidity * 1.25); },
    });
    changes.push(`minLiquidity ${oldV} -> raised`);
  }
  if (late.length >= 3 && avg(late.map((r) => r.pnl)) < 0) {
    const oldV = rules.maxPriceMoveSinceEntry;
    applyRuleChange(db, {
      reason: 'Late entries lose; reduce allowed price movement since wallet entry',
      evidenceSummary: `${late.length} resolved late-entry trades averaged ${avg(late.map((r) => r.pnl)).toFixed(2)} PnL`,
      expectedImprovement: 'Avoid chasing moved prices',
      mutate: (r) => { r.maxPriceMoveSinceEntry = Math.max(0.02, Math.round(r.maxPriceMoveSinceEntry * 0.8 * 100) / 100); },
    });
    changes.push(`maxPriceMoveSinceEntry ${oldV} -> reduced`);
  }

  // Downgrade wallets with poor recent paper performance
  const badWallets = db
    .prepare(
      `SELECT walletAddress, SUM(realizedPnl) AS total, COUNT(*) AS n
       FROM PaperTrade WHERE status = 'resolved' GROUP BY walletAddress HAVING n >= 3 AND total < -10`,
    )
    .all() as any[];
  for (const w of badWallets) {
    db.prepare("UPDATE WalletProfile SET status = 'ignore', statusReason = ?, updatedAt = datetime('now') WHERE address = ? AND status != 'ignore'")
      .run(`Auto-downgrade: ${w.n} resolved paper trades totaling ${Number(w.total).toFixed(2)} PnL`, w.walletAddress);
    changes.push(`wallet ${w.walletAddress} downgraded to ignore`);
  }
  return changes;
}
