// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Versioned rule sets + automatic rule changes with full audit trail. */
import type postgres from 'postgres';

export interface Rules {
  minLiquidity: number;
  maxSpread: number;
  maxPriceMoveSinceEntry: number; // absolute price move allowed after wallet entry
  minWalletGlobalScore: number;
  minCopyScore: number; // threshold for paper_copy
  minWatchScore: number; // threshold for watchlist
  minResolvedTrades: number;
  maxTimeToResolutionHours: number;
  /** Minimum fraction of a wallet's 30d trades that were short-term commitments. */
  minShortTermShare: number;
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
  maxTimeToResolutionHours: 24, // Short-term markets only (<= 24 hours to resolution)
  minShortTermShare: 0.5, // wallets that mostly trade long-term never reach 'track'
  weights: { roi: 0.2, consistency: 0.15, copyability: 0.15, categoryFit: 0.1, entryTiming: 0.1, spread: 0.1, liquidity: 0.1, thesis: 0.1 },
};

const finitePositive = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
};

const finiteFraction = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

/** Normalize persisted JSON at the trust boundary. Invalid config must fail closed to safe defaults,
 * never disable every signal with a negative/NaN horizon or silently poison scoring. */
export function normalizeRules(raw: unknown): Rules {
  const input = raw && typeof raw === 'object' ? raw as Partial<Rules> : {};
  const weights = input.weights && typeof input.weights === 'object' ? input.weights : {};
  return {
    minLiquidity: finitePositive(input.minLiquidity, DEFAULT_RULES.minLiquidity, 10_000_000),
    maxSpread: finitePositive(input.maxSpread, DEFAULT_RULES.maxSpread, 1),
    maxPriceMoveSinceEntry: finitePositive(input.maxPriceMoveSinceEntry, DEFAULT_RULES.maxPriceMoveSinceEntry, 1),
    minWalletGlobalScore: finiteFraction(input.minWalletGlobalScore, DEFAULT_RULES.minWalletGlobalScore),
    minCopyScore: finiteFraction(input.minCopyScore, DEFAULT_RULES.minCopyScore),
    minWatchScore: finiteFraction(input.minWatchScore, DEFAULT_RULES.minWatchScore),
    minResolvedTrades: Math.max(0, Math.floor(finitePositive(input.minResolvedTrades, DEFAULT_RULES.minResolvedTrades, 100_000))),
    maxTimeToResolutionHours: finitePositive(input.maxTimeToResolutionHours, DEFAULT_RULES.maxTimeToResolutionHours, 48),
    minShortTermShare: finiteFraction(input.minShortTermShare, DEFAULT_RULES.minShortTermShare),
    weights: {
      roi: finiteFraction((weights as Partial<Rules['weights']>).roi, DEFAULT_RULES.weights.roi),
      consistency: finiteFraction((weights as Partial<Rules['weights']>).consistency, DEFAULT_RULES.weights.consistency),
      copyability: finiteFraction((weights as Partial<Rules['weights']>).copyability, DEFAULT_RULES.weights.copyability),
      categoryFit: finiteFraction((weights as Partial<Rules['weights']>).categoryFit, DEFAULT_RULES.weights.categoryFit),
      entryTiming: finiteFraction((weights as Partial<Rules['weights']>).entryTiming, DEFAULT_RULES.weights.entryTiming),
      spread: finiteFraction((weights as Partial<Rules['weights']>).spread, DEFAULT_RULES.weights.spread),
      liquidity: finiteFraction((weights as Partial<Rules['weights']>).liquidity, DEFAULT_RULES.weights.liquidity),
      thesis: finiteFraction((weights as Partial<Rules['weights']>).thesis, DEFAULT_RULES.weights.thesis),
    },
  };
}

export async function getActiveRules(db: postgres.Sql): Promise<{ rules: Rules; version: number; id: number }> {
  const row = await db`SELECT "id", "version", "rulesJson" FROM "RuleSet" WHERE "active" = 1 ORDER BY "version" DESC LIMIT 1`;
  if (row.length === 0) {
    const res = await db`INSERT INTO "RuleSet" ("version", "active", "rulesJson") VALUES (1, 1, ${JSON.stringify(DEFAULT_RULES)}) RETURNING "id"`;
    return { rules: { ...DEFAULT_RULES }, version: 1, id: Number(res[0].id) };
  }
  const rules = normalizeRules(JSON.parse(row[0].rulesJson));
  return { rules, version: row[0].version, id: row[0].id };
}

export interface RuleChangeInput {
  reason: string;
  evidenceSummary: string;
  expectedImprovement: string;
  mutate: (r: Rules) => void;
}

/** Apply a rule change: new versioned RuleSet + RuleChange audit row. */
export async function applyRuleChange(db: postgres.Sql, change: RuleChangeInput): Promise<{ newVersion: number }> {
  const cur = await getActiveRules(db);
  const next: Rules = JSON.parse(JSON.stringify(cur.rules));
  change.mutate(next);
  const before = JSON.stringify(cur.rules);
  const after = JSON.stringify(next);
  if (before === after) return { newVersion: cur.version };
  const newVersion = cur.version + 1;
  await db`UPDATE "RuleSet" SET "active" = 0 WHERE "active" = 1`;
  const res = await db`INSERT INTO "RuleSet" ("version", "active", "rulesJson") VALUES (${newVersion}, 1, ${after}) RETURNING "id"`;
  await db`INSERT INTO "RuleChange" ("oldRuleSetId", "newRuleSetId", "changedBy", "reason", "evidenceSummary", "beforeJson", "afterJson", "expectedImprovement") 
           VALUES (${cur.id}, ${Number(res[0].id)}, 'hermes', ${change.reason}, ${change.evidenceSummary}, ${before}, ${after}, ${change.expectedImprovement})`;
  return { newVersion };
}

/** Self-improvement: inspect outcome reviews + paper results, adjust thresholds.
 * Returns list of changes made (each already logged with evidence). */
export async function autoUpdateRules(db: postgres.Sql): Promise<string[]> {
  const changes: string[] = [];
  const { rules } = await getActiveRules(db);

  // Evidence: performance of resolved paper trades bucketed by conditions at decision time
  const rows = await db`SELECT pt."realizedPnl" AS pnl, dj."spreadScore", dj."liquidityScore", dj."entryTimingScore"
       FROM "PaperTrade" pt JOIN "DecisionJournal" dj ON dj."id" = pt."decisionJournalId"
       WHERE pt."status" = 'resolved' AND pt."realizedPnl" IS NOT NULL`;
       
  if (rows.length < 5) return changes; // not enough evidence

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const wideSpread = rows.filter((r) => (r.spreadScore ?? 1) < 0.5);
  const lowLiq = rows.filter((r) => (r.liquidityScore ?? 1) < 0.5);
  const late = rows.filter((r) => (r.entryTimingScore ?? 1) < 0.5);

  if (wideSpread.length >= 3 && avg(wideSpread.map((r) => r.pnl)) < 0) {
    const oldV = rules.maxSpread;
    await applyRuleChange(db, {
      reason: 'Spread-heavy trades underperform; tighten max spread',
      evidenceSummary: `${wideSpread.length} resolved trades with low spread score averaged ${avg(wideSpread.map((r) => r.pnl)).toFixed(2)} PnL`,
      expectedImprovement: 'Fewer spread losses',
      mutate: (r) => { r.maxSpread = Math.max(0.01, Math.round(r.maxSpread * 0.8 * 100) / 100); },
    });
    changes.push(`maxSpread ${oldV} -> tightened`);
  }
  if (lowLiq.length >= 3 && avg(lowLiq.map((r) => r.pnl)) < 0) {
    const oldV = rules.minLiquidity;
    await applyRuleChange(db, {
      reason: 'Low-liquidity trades perform poorly; raise minimum liquidity',
      evidenceSummary: `${lowLiq.length} resolved trades with low liquidity score averaged ${avg(lowLiq.map((r) => r.pnl)).toFixed(2)} PnL`,
      expectedImprovement: 'Avoid unfillable copies',
      mutate: (r) => { r.minLiquidity = Math.round(r.minLiquidity * 1.25); },
    });
    changes.push(`minLiquidity ${oldV} -> raised`);
  }
  if (late.length >= 3 && avg(late.map((r) => r.pnl)) < 0) {
    const oldV = rules.maxPriceMoveSinceEntry;
    await applyRuleChange(db, {
      reason: 'Late entries lose; reduce allowed price movement since wallet entry',
      evidenceSummary: `${late.length} resolved late-entry trades averaged ${avg(late.map((r) => r.pnl)).toFixed(2)} PnL`,
      expectedImprovement: 'Avoid chasing moved prices',
      mutate: (r) => { r.maxPriceMoveSinceEntry = Math.max(0.02, Math.round(r.maxPriceMoveSinceEntry * 0.8 * 100) / 100); },
    });
    changes.push(`maxPriceMoveSinceEntry ${oldV} -> reduced`);
  }

  // Downgrade wallets with poor recent paper performance
  const badWallets = await db`SELECT "walletAddress", SUM("realizedPnl") AS total, COUNT(*) AS n
       FROM "PaperTrade" WHERE "status" = 'resolved' GROUP BY "walletAddress" HAVING COUNT(*) >= 3 AND SUM("realizedPnl") < -10`;
       
  for (const w of badWallets) {
    const reason = `Auto-downgrade: ${w.n} resolved paper trades totaling ${Number(w.total).toFixed(2)} PnL`;
    await db`UPDATE "WalletProfile" SET "status" = 'ignore', "statusReason" = ${reason}, "updatedAt" = CURRENT_TIMESTAMP WHERE "address" = ${w.walletAddress} AND "status" != 'ignore'`;
    changes.push(`wallet ${w.walletAddress} downgraded to ignore`);
  }
  return changes;
}
