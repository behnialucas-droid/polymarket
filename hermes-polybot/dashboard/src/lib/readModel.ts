// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Signed-ledger read model — the single query surface for reporting.
 * Read-only aggregation over the v2 signed book; no report should hand-roll
 * SQL over ledger tables. Legacy PaperTrade aggregates are frozen history and
 * live only where explicitly labelled. */
import type postgres from 'postgres';

export interface SignedAccountSummary {
  accountId: number | null;
  startingCash: number;
  reservedCollateral: number;
  realizedPnl: number;
  availableCollateral: number;
  openPositions: number;
  awaitingSettlement: number;
  latestUnrealizedPnl: number;
}

export interface AdmissionFunnel {
  observed: number;
  scored: number;
  paperCopy: number;
  admissionChecks: number;
  admitted: number;
  opened: number;
  settled: number;
  rejectionCodes: Record<string, number>;
}

export async function getSignedAccountSummary(db: postgres.Sql, isDemo: boolean): Promise<SignedAccountSummary> {
  const accounts = await db`
    SELECT "id", "startingCash" FROM "PaperAccount"
    WHERE "strategyKey" = 'hermes-signed-v2' AND "isDemo" = ${isDemo ? 1 : 0}
  `;
  if (!accounts.length) {
    return {
      accountId: null, startingCash: 0, reservedCollateral: 0, realizedPnl: 0,
      availableCollateral: 0, openPositions: 0, awaitingSettlement: 0, latestUnrealizedPnl: 0,
    };
  }
  const accountId = Number(accounts[0].id);
  const [totals] = await db`
    SELECT
      COALESCE(SUM("reservedCollateral"), 0)::float AS "reserved",
      COALESCE(SUM("realizedPnl"), 0)::float AS "realized",
      COUNT(*) FILTER (WHERE "status" = 'open' AND ("longShares" > 0 OR "shortShares" > 0))::int AS "open",
      COUNT(*) FILTER (WHERE "status" = 'awaiting_settlement')::int AS "awaiting"
    FROM "SignedPaperPosition" WHERE "paperAccountId" = ${accountId}
  `;
  const [marks] = await db`
    SELECT COALESCE(SUM(s."unrealizedPnl"), 0)::float AS "unrealized"
    FROM "SignedPaperPosition" p
    JOIN LATERAL (
      SELECT "unrealizedPnl" FROM "SignedPnlSnapshot"
      WHERE "signedPaperPositionId" = p."id"
      ORDER BY "collectedAt" DESC, "id" DESC LIMIT 1
    ) s ON TRUE
    WHERE p."paperAccountId" = ${accountId} AND p."status" = 'open'
      AND (p."longShares" > 0 OR p."shortShares" > 0)
  `;
  const startingCash = Number(accounts[0].startingCash);
  const reserved = Number(totals.reserved);
  const realized = Number(totals.realized);
  return {
    accountId,
    startingCash,
    reservedCollateral: reserved,
    realizedPnl: realized,
    availableCollateral: startingCash + realized - reserved,
    openPositions: Number(totals.open),
    awaitingSettlement: Number(totals.awaiting),
    latestUnrealizedPnl: Number(marks?.unrealized ?? 0),
  };
}

export async function getAdmissionFunnel(db: postgres.Sql, sinceIso: string): Promise<AdmissionFunnel> {
  const [counts] = await db`
    SELECT
      (SELECT COUNT(*)::int FROM "ObservedTrade" WHERE "createdAt" >= ${sinceIso}) AS "observed",
      (SELECT COUNT(*)::int FROM "DecisionJournal" WHERE "createdAt" >= ${sinceIso}) AS "scored",
      (SELECT COUNT(*)::int FROM "DecisionJournal" WHERE "decision" = 'paper_copy' AND "createdAt" >= ${sinceIso}) AS "paperCopy",
      (SELECT COUNT(*)::int FROM "AdmissionCheck" WHERE "createdAt" >= ${sinceIso}) AS "admissionChecks",
      (SELECT COUNT(*)::int FROM "AdmissionCheck" WHERE "admitted" = 1 AND "createdAt" >= ${sinceIso}) AS "admitted",
      (SELECT COUNT(*)::int FROM "PaperStrategyAction" WHERE "createdAt" >= ${sinceIso}) AS "opened",
      (SELECT COUNT(*)::int FROM "SignedPaperLedgerEntry" WHERE "eventType" = 'SETTLE' AND "createdAt" >= ${sinceIso}) AS "settled"
  `;
  const rejectionRows = await db`
    SELECT "rejectionsJson" FROM "AdmissionCheck"
    WHERE "admitted" = 0 AND "createdAt" >= ${sinceIso}
  `;
  const rejectionCodes: Record<string, number> = {};
  for (const row of rejectionRows) {
    try {
      for (const rejection of JSON.parse(row.rejectionsJson)) {
        const code = String(rejection.code ?? 'UNKNOWN');
        rejectionCodes[code] = (rejectionCodes[code] ?? 0) + 1;
      }
    } catch { rejectionCodes.MALFORMED = (rejectionCodes.MALFORMED ?? 0) + 1; }
  }
  return {
    observed: Number(counts.observed),
    scored: Number(counts.scored),
    paperCopy: Number(counts.paperCopy),
    admissionChecks: Number(counts.admissionChecks),
    admitted: Number(counts.admitted),
    opened: Number(counts.opened),
    settled: Number(counts.settled),
    rejectionCodes,
  };
}
