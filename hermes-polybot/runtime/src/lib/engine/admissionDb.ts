/** DB access for risk admission. All portfolio reads happen inside the caller's
 * transaction with the PaperAccount row locked, so concurrent admissions for the
 * same account serialize and cannot double-spend collateral. */
import type postgres from 'postgres';
import { toMicros } from './decimal.ts';
import type { CostModelParams } from './costModel.ts';
import type { PortfolioState, RiskLimits, AdmissionResult } from './admission.ts';
import { validateRiskLimits } from './admission.ts';
import { validateCostModelParams } from './costModel.ts';

export async function loadActiveCostModelParams(db: postgres.Sql): Promise<CostModelParams> {
  const rows = await db`SELECT "paramsJson" FROM "CostModelParams" WHERE "active" = 1`;
  if (rows.length !== 1) throw new Error(`expected exactly one active CostModelParams row, found ${rows.length}`);
  const params = JSON.parse(rows[0].paramsJson) as CostModelParams;
  validateCostModelParams(params);
  return params;
}

export async function loadActiveRiskLimits(db: postgres.Sql): Promise<RiskLimits> {
  const rows = await db`SELECT "limitsJson" FROM "RiskLimit" WHERE "active" = 1`;
  if (rows.length !== 1) throw new Error(`expected exactly one active RiskLimit row, found ${rows.length}`);
  const raw = JSON.parse(rows[0].limitsJson);
  const limits: RiskLimits = {
    version: String(raw.version),
    maxGrossExposureMicros: toMicros(raw.maxGrossExposureUsd),
    maxNetExposureMicros: toMicros(raw.maxNetExposureUsd),
    maxPerInstrumentMicros: toMicros(raw.maxPerInstrumentUsd),
    maxPerWalletMicros: toMicros(raw.maxPerWalletUsd),
    maxPerCategoryMicros: toMicros(raw.maxPerCategoryUsd),
    maxDailyTurnoverMicros: toMicros(raw.maxDailyTurnoverUsd),
    maxConcurrentPositions: Number(raw.maxConcurrentPositions),
    maxQuoteAgeMs: Number(raw.maxQuoteAgeMs),
    maxSpread: Number(raw.maxSpread),
    minLiquidity: Number(raw.minLiquidity),
    maxHorizonHours: Number(raw.maxHorizonHours),
    shortBufferPerShare: Number(raw.shortBufferPerShare),
  };
  validateRiskLimits(limits);
  return limits;
}

export interface PortfolioQueryKeys {
  paperAccountId: number;
  conditionId: string | null;
  assetId: string | null;
  outcome: string | null;
  walletAddress: string;
  category: string | null;
  idempotencyKey: string;
}

/** Locks the account row, then aggregates exposure on a reserved-collateral basis. */
export async function loadPortfolioState(
  tx: postgres.Sql,
  keys: PortfolioQueryKeys,
): Promise<PortfolioState> {
  const accounts = await tx`
    SELECT "startingCash" FROM "PaperAccount" WHERE "id" = ${keys.paperAccountId} FOR UPDATE
  `;
  if (!accounts.length) throw new Error(`paper account ${keys.paperAccountId} not found`);
  const startingCashMicros = toMicros(String(accounts[0].startingCash));

  const totals = await tx`
    SELECT
      COALESCE(SUM(p."reservedCollateral"), 0) AS "reserved",
      COALESCE(SUM(p."realizedPnl"), 0) AS "realized",
      COUNT(*) FILTER (WHERE p."status" = 'open' AND (p."longShares" > 0 OR p."shortShares" > 0)) AS "openCount"
    FROM "SignedPaperPosition" p
    WHERE p."paperAccountId" = ${keys.paperAccountId}
  `;
  const reservedMicros = toMicros(String(totals[0].reserved));
  const realizedMicros = toMicros(String(totals[0].realized));
  const openPositionCount = Number(totals[0].openCount);

  const lotRows = await tx`
    SELECT l."direction",
           COALESCE(SUM(l."reservedCollateral" * l."remainingShares" / l."openedShares"), 0) AS "collateral",
           COALESCE(SUM(l."reservedCollateral" * l."remainingShares" / l."openedShares")
             FILTER (WHERE i."conditionId" = ${keys.conditionId} AND i."assetId" = ${keys.assetId} AND i."outcome" = ${keys.outcome}), 0) AS "instrumentCollateral",
           COALESCE(SUM(l."reservedCollateral" * l."remainingShares" / l."openedShares")
             FILTER (WHERE ot."walletAddress" = ${keys.walletAddress}), 0) AS "walletCollateral",
           COALESCE(SUM(l."reservedCollateral" * l."remainingShares" / l."openedShares")
             FILTER (WHERE ot."marketCategory" IS NOT DISTINCT FROM ${keys.category}), 0) AS "categoryCollateral"
    FROM "SignedPaperLot" l
    JOIN "SignedPaperPosition" p ON p."id" = l."signedPaperPositionId"
    JOIN "PaperInstrument" i ON i."id" = p."paperInstrumentId"
    JOIN "PaperStrategyAction" a ON a."id" = l."paperStrategyActionId"
    JOIN "ObservedTrade" ot ON ot."id" = a."sourceObservedTradeId"
    WHERE p."paperAccountId" = ${keys.paperAccountId} AND l."remainingShares" > 0
    GROUP BY l."direction"
  `;
  let grossExposureMicros = 0n;
  let netExposureMicros = 0n;
  let instrumentExposureMicros = 0n;
  let walletExposureMicros = 0n;
  let categoryExposureMicros = 0n;
  for (const row of lotRows) {
    const collateral = toMicros(String(row.collateral));
    grossExposureMicros += collateral;
    netExposureMicros += row.direction === 'LONG' ? collateral : -collateral;
    instrumentExposureMicros += toMicros(String(row.instrumentCollateral));
    walletExposureMicros += toMicros(String(row.walletCollateral));
    categoryExposureMicros += toMicros(String(row.categoryCollateral));
  }

  const turnover = await tx`
    SELECT COALESCE(SUM("requiredCollateral"), 0) AS "turnover"
    FROM "AdmissionCheck"
    WHERE "paperAccountId" = ${keys.paperAccountId}
      AND "admitted" = 1
      AND "createdAt" >= date_trunc('day', CURRENT_TIMESTAMP)
  `;
  const dailyTurnoverMicros = toMicros(String(turnover[0].turnover));

  const duplicates = await tx`
    SELECT 1 FROM "AdmissionCheck" WHERE "idempotencyKey" = ${keys.idempotencyKey}
  `;
  const openedNewInstrument = keys.conditionId == null || instrumentExposureMicros === 0n;

  return {
    availableCollateralMicros: startingCashMicros + realizedMicros - reservedMicros,
    grossExposureMicros,
    netExposureMicros,
    instrumentExposureMicros,
    walletExposureMicros,
    categoryExposureMicros,
    dailyTurnoverMicros,
    openPositionCount,
    openedNewInstrument,
    duplicateIdempotencyKey: duplicates.length > 0,
  };
}

export async function recordAdmissionCheck(
  tx: postgres.Sql,
  keys: { paperAccountId: number; decisionJournalId: number; observedTradeId: number; idempotencyKey: string },
  result: AdmissionResult,
  costModelVersion: string,
): Promise<number> {
  const rows = await tx`
    INSERT INTO "AdmissionCheck" (
      "paperAccountId", "decisionJournalId", "observedTradeId", "admitted",
      "rejectionsJson", "costJson", "sizedShares", "requiredCollateral",
      "costModelVersion", "riskLimitVersion", "idempotencyKey"
    ) VALUES (
      ${keys.paperAccountId}, ${keys.decisionJournalId}, ${keys.observedTradeId}, ${result.admitted ? 1 : 0},
      ${JSON.stringify(result.rejections)},
      ${JSON.stringify({
        executable: result.cost.executable,
        effectivePrice: result.cost.effectivePrice,
        expectedFillShares: result.cost.expectedFillShares,
        fees: result.cost.feesMicros.toString(),
        slippage: result.cost.slippageMicros.toString(),
        impactBps: result.cost.impactBps,
        latencyBps: result.cost.latencyBps,
        reason: result.cost.reason,
      })},
      ${result.admitted ? result.sizedShares : null},
      ${result.admitted ? (Number(result.requiredCollateralMicros) / 1e6).toFixed(6) : null},
      ${costModelVersion}, ${result.riskLimitVersion}, ${keys.idempotencyKey}
    )
    RETURNING "id"
  `;
  return Number(rows[0].id);
}
