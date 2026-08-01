/** Preregistered trial evaluation: three arms, one cost model, no lookahead.
 *  (a) hermes  — realized net PnL of the signed v2 account (actual ledger);
 *  (b) blind   — every observed source trade copied at flat notional, costs applied;
 *  (c) skip    — the same counterfactual restricted to trades Hermes did NOT admit.
 * Counterfactual resolution comes ONLY from confirmed MarketResolutionEvidence.
 * Unresolved exposure is reported separately and is excluded from every arm. */
import type postgres from 'postgres';
import { blockBootstrapTotal, maxDrawdown, type BootstrapResult } from './stats.ts';

export interface ArmSummary {
  trades: number;
  totalNetPnl: number;
  winRate: number;
  maxDrawdown: number;
  bootstrap: BootstrapResult | null;
}

export interface TrialEvaluation {
  generatedAt: string;
  windowDays: number;
  seed: number;
  versions: { rules: string | null; costModel: string | null; riskLimit: string | null };
  hermes: ArmSummary;
  blindCopy: ArmSummary;
  skippedCounterfactual: ArmSummary;
  unresolved: { positions: number; reservedCollateral: number };
  admissionFunnel: { observed: number; scored: number; paperCopy: number; admitted: number; opened: number; settled: number };
}

const BLIND_NOTIONAL_USD = 10;

function summarizeDaily(perTrade: Array<{ day: string; pnl: number }>, seed: number): ArmSummary {
  const trades = perTrade.length;
  const totalNetPnl = perTrade.reduce((a, r) => a + r.pnl, 0);
  const wins = perTrade.filter((r) => r.pnl > 0).length;
  const byDay = new Map<string, number>();
  for (const r of perTrade) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.pnl);
  const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  return {
    trades,
    totalNetPnl: Math.round(totalNetPnl * 1e6) / 1e6,
    winRate: trades ? Math.round((wins / trades) * 1e4) / 1e4 : 0,
    maxDrawdown: Math.round(maxDrawdown(daily) * 1e6) / 1e6,
    bootstrap: daily.length >= 2 ? blockBootstrapTotal(daily, { seed }) : null,
  };
}

export async function evaluateTrial(db: postgres.Sql, options: { seed: number; windowDays?: number }): Promise<TrialEvaluation> {
  const windowDays = options.windowDays ?? 30;
  const since = new Date(Date.now() - windowDays * 864e5).toISOString();

  const versions = await Promise.all([
    db`SELECT "version" FROM "RuleSet" WHERE "isActive" = 1 ORDER BY "id" DESC LIMIT 1`.catch(() => []),
    db`SELECT "version" FROM "CostModelParams" WHERE "active" = 1`,
    db`SELECT "version" FROM "RiskLimit" WHERE "active" = 1`,
  ]);

  // Arm (a): realized signed-ledger PnL by settlement day.
  const hermesRows = await db`
    SELECT to_char(e."createdAt", 'YYYY-MM-DD') AS "day", e."realizedPnlDelta" AS "pnl"
    FROM "SignedPaperLedgerEntry" e
    WHERE e."eventType" IN ('SETTLE', 'CLOSE_LONG', 'CLOSE_SHORT')
      AND e."createdAt" >= ${since}
  `;

  // Counterfactual base: observed trades with confirmed resolution only.
  const counterfactual = await db`
    SELECT ot."id", ot."side", ot."outcome", ot."walletEntryPrice" AS "entry",
           to_char(ot."createdAt", 'YYYY-MM-DD') AS "day",
           mre."resolvedOutcome" AS "confirmedOutcome",
           dj."decision",
           EXISTS (
             SELECT 1 FROM "AdmissionCheck" ac
             WHERE ac."observedTradeId" = ot."id" AND ac."admitted" = 1
           ) AS "admitted"
    FROM "ObservedTrade" ot
    JOIN "MarketResolutionEvidence" mre ON mre."conditionId" = ot."conditionId" AND mre."status" = 'confirmed'
    LEFT JOIN "DecisionJournal" dj ON dj."observedTradeId" = ot."id"
    WHERE ot."createdAt" >= ${since}
  `;

  const blind: Array<{ day: string; pnl: number }> = [];
  const skipped: Array<{ day: string; pnl: number }> = [];
  for (const row of counterfactual) {
    const entry = Number(row.entry);
    if (!Number.isFinite(entry) || entry <= 0 || entry >= 1) continue;
    const won = String(row.confirmedOutcome).toUpperCase() === String(row.outcome ?? '').toUpperCase();
    const shares = BLIND_NOTIONAL_USD / entry;
    // Source BUY copied long; source SELL copied short — both cost-adjusted by
    // a flat conservative haircut of the entry (half-spread floor 50bps + fee 20bps).
    const costHaircut = BLIND_NOTIONAL_USD * 0.007;
    const gross = row.side === 'SELL'
      ? shares * (entry - (won ? 1 : 0))
      : shares * ((won ? 1 : 0) - entry);
    const pnl = gross - costHaircut;
    blind.push({ day: row.day, pnl });
    if (!row.admitted) skipped.push({ day: row.day, pnl });
  }

  const unresolvedRows = await db`
    SELECT COUNT(*) AS "positions", COALESCE(SUM("reservedCollateral"), 0) AS "reserved"
    FROM "SignedPaperPosition"
    WHERE "status" = 'open' AND ("longShares" > 0 OR "shortShares" > 0)
  `;

  const funnel = await db`
    SELECT
      (SELECT COUNT(*) FROM "ObservedTrade" WHERE "createdAt" >= ${since}) AS "observed",
      (SELECT COUNT(*) FROM "DecisionJournal" WHERE "createdAt" >= ${since}) AS "scored",
      (SELECT COUNT(*) FROM "DecisionJournal" WHERE "decision" = 'paper_copy' AND "createdAt" >= ${since}) AS "paperCopy",
      (SELECT COUNT(*) FROM "AdmissionCheck" WHERE "admitted" = 1 AND "createdAt" >= ${since}) AS "admitted",
      (SELECT COUNT(*) FROM "PaperStrategyAction" WHERE "createdAt" >= ${since}) AS "opened",
      (SELECT COUNT(*) FROM "SignedPaperLedgerEntry" WHERE "eventType" = 'SETTLE' AND "createdAt" >= ${since}) AS "settled"
  `;

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    seed: options.seed,
    versions: {
      rules: versions[0][0]?.version != null ? String(versions[0][0].version) : null,
      costModel: versions[1][0]?.version != null ? String(versions[1][0].version) : null,
      riskLimit: versions[2][0]?.version != null ? String(versions[2][0].version) : null,
    },
    hermes: summarizeDaily(hermesRows.map((r) => ({ day: r.day, pnl: Number(r.pnl) })), options.seed),
    blindCopy: summarizeDaily(blind, options.seed),
    skippedCounterfactual: summarizeDaily(skipped, options.seed),
    unresolved: {
      positions: Number(unresolvedRows[0].positions),
      reservedCollateral: Number(unresolvedRows[0].reserved),
    },
    admissionFunnel: {
      observed: Number(funnel[0].observed),
      scored: Number(funnel[0].scored),
      paperCopy: Number(funnel[0].paperCopy),
      admitted: Number(funnel[0].admitted),
      opened: Number(funnel[0].opened),
      settled: Number(funnel[0].settled),
    },
  };
}
