// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Versioned execution-cost model for paper fills.
 * Every coefficient is a stored model assumption (CostModelParams row), never a
 * measurement. Costs are always applied ADVERSELY: a long pays up from the ask,
 * a short receives less than the bid. If the adjusted price leaves (0,1) the
 * candidate is simply not executable — never clamped into fake profitability. */
import { toMicros } from './decimal.ts';
import type { PositionDirection } from './signedPaperLedger.ts';

export interface CostModelParams {
  version: string;
  /** Taker fee in basis points of traded share notional. */
  feeBps: number;
  /** Floor on assumed half-spread cost (bps of mid) when the book looks unrealistically tight. */
  halfSpreadFloorBps: number;
  /** Price impact in bps of mid at 100% participation of visible liquidity. */
  impactCoeff: number;
  /** Participation exponent for the impact curve (0 < e <= 1 is concave). */
  impactExponent: number;
  /** Assumed decision-to-fill latency. */
  latencyMs: number;
  /** Adverse price drift per second of latency, in bps of mid. */
  latencyDriftBpsPerSec: number;
  /** Max fraction of visible liquidity assumed fillable at the modeled price. */
  maxFillFraction: number;
}

export interface CostQuote {
  bestBid: number;
  bestAsk: number;
  liquidity: number;
}

export interface ExecutionCostInput {
  direction: PositionDirection;
  requestedShares: number;
  quote: CostQuote;
}

export interface ExecutionCost {
  executable: boolean;
  reason?: string;
  costModelVersion: string;
  /** Adverse fill price after half-spread floor, impact, and latency drift. */
  effectivePrice: number;
  expectedFillShares: number;
  feesMicros: bigint;
  slippageMicros: bigint;
  impactBps: number;
  latencyBps: number;
}

function reject(version: string, reason: string): ExecutionCost {
  return {
    executable: false,
    reason,
    costModelVersion: version,
    effectivePrice: NaN,
    expectedFillShares: 0,
    feesMicros: 0n,
    slippageMicros: 0n,
    impactBps: 0,
    latencyBps: 0,
  };
}

export function validateCostModelParams(p: CostModelParams): void {
  if (!p.version) throw new Error('cost model version is required');
  for (const [key, min, max] of [
    ['feeBps', 0, 10_000],
    ['halfSpreadFloorBps', 0, 10_000],
    ['impactCoeff', 0, 100_000],
    ['impactExponent', 0.05, 2],
    ['latencyMs', 0, 600_000],
    ['latencyDriftBpsPerSec', 0, 10_000],
    ['maxFillFraction', 0.000001, 1],
  ] as const) {
    const value = (p as any)[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`cost model ${key} out of range [${min}, ${max}]: ${value}`);
    }
  }
}

export function computeExecutionCost(params: CostModelParams, input: ExecutionCostInput): ExecutionCost {
  validateCostModelParams(params);
  const { direction, requestedShares, quote } = input;
  if (!Number.isFinite(requestedShares) || requestedShares <= 0) {
    return reject(params.version, 'requested shares must be positive');
  }
  const { bestBid, bestAsk, liquidity } = quote;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk >= 1 || bestAsk < bestBid) {
    return reject(params.version, 'quote has no executable two-sided book');
  }
  if (!Number.isFinite(liquidity) || liquidity <= 0) {
    return reject(params.version, 'quote has no visible liquidity');
  }

  const mid = (bestBid + bestAsk) / 2;
  const basePrice = direction === 'LONG' ? bestAsk : bestBid;
  const bookHalfSpread = (bestAsk - bestBid) / 2;
  const flooredHalfSpread = Math.max(bookHalfSpread, (params.halfSpreadFloorBps / 10_000) * mid);
  const extraHalfSpread = flooredHalfSpread - bookHalfSpread;

  const requestedNotional = requestedShares * mid;
  const participation = requestedNotional / liquidity;
  const impactBps = params.impactCoeff * Math.pow(participation, params.impactExponent);
  const latencyBps = params.latencyDriftBpsPerSec * (params.latencyMs / 1000);
  const adverse = extraHalfSpread + ((impactBps + latencyBps) / 10_000) * mid;

  const effectivePrice = direction === 'LONG' ? basePrice + adverse : basePrice - adverse;
  if (effectivePrice <= 0 || effectivePrice >= 1) {
    return reject(params.version, `modeled fill price ${effectivePrice.toFixed(6)} is outside (0, 1)`);
  }

  const fillableShares = (params.maxFillFraction * liquidity) / effectivePrice;
  const expectedFillShares = Math.min(requestedShares, fillableShares);
  if (expectedFillShares <= 0) return reject(params.version, 'no fillable size at modeled price');

  const feesMicros = toMicros((params.feeBps / 10_000) * expectedFillShares * effectivePrice);
  const slippagePerShare = Math.abs(effectivePrice - basePrice);
  const slippageMicros = toMicros(slippagePerShare * expectedFillShares);

  return {
    executable: true,
    costModelVersion: params.version,
    effectivePrice,
    expectedFillShares,
    feesMicros,
    slippageMicros,
    impactBps,
    latencyBps,
  };
}
