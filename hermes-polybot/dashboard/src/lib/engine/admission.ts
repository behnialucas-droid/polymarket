// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Pure risk-admission decision. Runs AFTER scoring, BEFORE any ledger write.
 * All rejections are collected (not short-circuited) so the journal records
 * every violated limit. Exposure is measured on a reserved-collateral basis:
 * conservative, additive, and identical to what the signed ledger locks. */
import { collateralFor, type PositionDirection } from './signedPaperLedger.ts';
import { computeExecutionCost, type CostModelParams, type CostQuote, type ExecutionCost } from './costModel.ts';
import { addMicros, absMicros, toMicros } from './decimal.ts';

export interface RiskLimits {
  version: string;
  maxGrossExposureMicros: bigint;
  maxNetExposureMicros: bigint;
  maxPerInstrumentMicros: bigint;
  maxPerWalletMicros: bigint;
  maxPerCategoryMicros: bigint;
  maxDailyTurnoverMicros: bigint;
  maxConcurrentPositions: number;
  maxQuoteAgeMs: number;
  maxSpread: number;
  minLiquidity: number;
  maxHorizonHours: number;
  /** Extra short collateral per share, absolute price units (e.g. 0.02). */
  shortBufferPerShare: number;
}

export interface PortfolioState {
  availableCollateralMicros: bigint;
  grossExposureMicros: bigint;
  /** Signed: long collateral positive, short collateral negative. */
  netExposureMicros: bigint;
  instrumentExposureMicros: bigint;
  walletExposureMicros: bigint;
  categoryExposureMicros: bigint;
  dailyTurnoverMicros: bigint;
  openPositionCount: number;
  openedNewInstrument: boolean;
  duplicateIdempotencyKey: boolean;
}

export interface AdmissionCandidate {
  direction: PositionDirection;
  requestedNotionalUsd: number;
  quote: CostQuote;
  quoteAgeMs: number;
  hoursToResolution: number | undefined;
}

export type RejectionCode =
  | 'NOT_EXECUTABLE'
  | 'STALE_QUOTE'
  | 'SPREAD_TOO_WIDE'
  | 'LIQUIDITY_TOO_LOW'
  | 'HORIZON_EXCEEDED'
  | 'INSUFFICIENT_COLLATERAL'
  | 'GROSS_CAP'
  | 'NET_CAP'
  | 'INSTRUMENT_CAP'
  | 'WALLET_CAP'
  | 'CATEGORY_CAP'
  | 'TURNOVER_CAP'
  | 'MAX_CONCURRENT'
  | 'DUPLICATE';

export interface Rejection {
  code: RejectionCode;
  detail: string;
}

export interface AdmissionResult {
  admitted: boolean;
  rejections: Rejection[];
  sizedShares: number;
  requiredCollateralMicros: bigint;
  cost: ExecutionCost;
  riskLimitVersion: string;
}

export function validateRiskLimits(limits: RiskLimits): void {
  if (!limits.version) throw new Error('risk limit version is required');
  const microFields: Array<keyof RiskLimits> = [
    'maxGrossExposureMicros', 'maxNetExposureMicros', 'maxPerInstrumentMicros',
    'maxPerWalletMicros', 'maxPerCategoryMicros', 'maxDailyTurnoverMicros',
  ];
  for (const field of microFields) {
    if (typeof limits[field] !== 'bigint' || (limits[field] as bigint) <= 0n) {
      throw new Error(`risk limit ${field} must be a positive bigint`);
    }
  }
  for (const [key, min, max] of [
    ['maxConcurrentPositions', 1, 10_000],
    ['maxQuoteAgeMs', 1, 86_400_000],
    ['maxSpread', 0.0001, 1],
    ['minLiquidity', 0, 1e12],
    ['maxHorizonHours', 0.01, 8760],
    ['shortBufferPerShare', 0, 0.5],
  ] as const) {
    const value = (limits as any)[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`risk limit ${key} out of range [${min}, ${max}]: ${value}`);
    }
  }
}

export function evaluateAdmission(
  limits: RiskLimits,
  costParams: CostModelParams,
  candidate: AdmissionCandidate,
  portfolio: PortfolioState,
): AdmissionResult {
  validateRiskLimits(limits);
  const rejections: Rejection[] = [];
  const reject = (code: RejectionCode, detail: string) => rejections.push({ code, detail });

  if (!Number.isFinite(candidate.requestedNotionalUsd) || candidate.requestedNotionalUsd <= 0) {
    reject('NOT_EXECUTABLE', `requested notional must be positive, got ${candidate.requestedNotionalUsd}`);
  }
  if (candidate.quoteAgeMs < 0 || candidate.quoteAgeMs > limits.maxQuoteAgeMs) {
    reject('STALE_QUOTE', `quote age ${candidate.quoteAgeMs}ms outside [0, ${limits.maxQuoteAgeMs}]ms`);
  }
  const spread = candidate.quote.bestAsk - candidate.quote.bestBid;
  if (!Number.isFinite(spread) || spread > limits.maxSpread) {
    reject('SPREAD_TOO_WIDE', `spread ${spread} above maximum ${limits.maxSpread}`);
  }
  if (candidate.quote.liquidity < limits.minLiquidity) {
    reject('LIQUIDITY_TOO_LOW', `liquidity ${candidate.quote.liquidity} below minimum ${limits.minLiquidity}`);
  }
  const ttr = candidate.hoursToResolution;
  if (ttr === undefined || ttr <= 0 || ttr > limits.maxHorizonHours) {
    reject('HORIZON_EXCEEDED', `hoursToResolution ${ttr ?? 'unknown'} outside (0, ${limits.maxHorizonHours}]`);
  }
  if (portfolio.duplicateIdempotencyKey) {
    reject('DUPLICATE', 'an admission with this idempotency key already exists');
  }

  const mid = (candidate.quote.bestBid + candidate.quote.bestAsk) / 2;
  const requestedShares = mid > 0 ? candidate.requestedNotionalUsd / mid : 0;
  const cost = computeExecutionCost(costParams, {
    direction: candidate.direction,
    requestedShares,
    quote: candidate.quote,
  });
  if (!cost.executable) {
    reject('NOT_EXECUTABLE', cost.reason ?? 'cost model refused the candidate');
    return {
      admitted: false, rejections, sizedShares: 0, requiredCollateralMicros: 0n,
      cost, riskLimitVersion: limits.version,
    };
  }

  const sizedShares = cost.expectedFillShares;
  const buffer = candidate.direction === 'SHORT' ? limits.shortBufferPerShare * sizedShares : 0;
  const requiredCollateral = collateralFor(
    candidate.direction, sizedShares, cost.effectivePrice,
    Number(cost.feesMicros) / 1_000_000, buffer,
  );
  const requiredCollateralMicros = toMicros(requiredCollateral);

  if (requiredCollateralMicros > portfolio.availableCollateralMicros) {
    reject('INSUFFICIENT_COLLATERAL', `requires ${requiredCollateral.toFixed(6)} with ${(Number(portfolio.availableCollateralMicros) / 1e6).toFixed(6)} available`);
  }
  const nextGross = addMicros(portfolio.grossExposureMicros, requiredCollateralMicros);
  if (nextGross > limits.maxGrossExposureMicros) {
    reject('GROSS_CAP', `gross exposure would reach ${nextGross} micros (cap ${limits.maxGrossExposureMicros})`);
  }
  const signedDelta = candidate.direction === 'LONG' ? requiredCollateralMicros : -requiredCollateralMicros;
  const nextNet = absMicros(addMicros(portfolio.netExposureMicros, signedDelta));
  if (nextNet > limits.maxNetExposureMicros) {
    reject('NET_CAP', `net exposure would reach ${nextNet} micros (cap ${limits.maxNetExposureMicros})`);
  }
  const nextInstrument = addMicros(portfolio.instrumentExposureMicros, requiredCollateralMicros);
  if (nextInstrument > limits.maxPerInstrumentMicros) {
    reject('INSTRUMENT_CAP', `instrument exposure would reach ${nextInstrument} micros (cap ${limits.maxPerInstrumentMicros})`);
  }
  const nextWallet = addMicros(portfolio.walletExposureMicros, requiredCollateralMicros);
  if (nextWallet > limits.maxPerWalletMicros) {
    reject('WALLET_CAP', `wallet-attributed exposure would reach ${nextWallet} micros (cap ${limits.maxPerWalletMicros})`);
  }
  const nextCategory = addMicros(portfolio.categoryExposureMicros, requiredCollateralMicros);
  if (nextCategory > limits.maxPerCategoryMicros) {
    reject('CATEGORY_CAP', `category exposure would reach ${nextCategory} micros (cap ${limits.maxPerCategoryMicros})`);
  }
  const nextTurnover = addMicros(portfolio.dailyTurnoverMicros, requiredCollateralMicros);
  if (nextTurnover > limits.maxDailyTurnoverMicros) {
    reject('TURNOVER_CAP', `daily turnover would reach ${nextTurnover} micros (cap ${limits.maxDailyTurnoverMicros})`);
  }
  if (portfolio.openedNewInstrument && portfolio.openPositionCount >= limits.maxConcurrentPositions) {
    reject('MAX_CONCURRENT', `${portfolio.openPositionCount} open positions at cap ${limits.maxConcurrentPositions}`);
  }

  return {
    admitted: rejections.length === 0,
    rejections,
    sizedShares,
    requiredCollateralMicros,
    cost,
    riskLimitVersion: limits.version,
  };
}
