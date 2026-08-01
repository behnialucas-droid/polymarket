// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Pure settlement policy.
 * `confirmed` requires an explicit provider resolution signal; the >0.85 price
 * heuristic can only ever PROPOSE. Unknown, disputed, or in-flight markets
 * return null and stay awaiting settlement — an unresolved market is exposure,
 * never a default loss. */
import type { MarketData } from '../adapters/types.ts';
import { settlementPnl, type PositionDirection } from './signedPaperLedger.ts';

export type ResolutionStatus = 'confirmed' | 'proposed';

export interface ResolutionEvaluation {
  status: ResolutionStatus;
  resolvedOutcome: string;
  resolutionSource: string;
}

export function evaluateResolution(market: MarketData): ResolutionEvaluation | null {
  const raw = (market.raw ?? {}) as Record<string, unknown>;
  const uma = typeof raw.umaResolutionStatus === 'string' ? raw.umaResolutionStatus.toLowerCase() : undefined;
  const outcome = market.resolvedOutcome;
  if (uma === 'resolved' && outcome) {
    return { status: 'confirmed', resolvedOutcome: String(outcome), resolutionSource: 'uma' };
  }
  if (market.resolved && outcome) {
    return { status: 'proposed', resolvedOutcome: String(outcome), resolutionSource: 'closed-price-heuristic' };
  }
  return null;
}

/** Binary payout of one share of `instrumentOutcome` under a final resolution. */
export function settlementPayout(resolvedOutcome: string, instrumentOutcome: string): 0 | 1 {
  return resolvedOutcome.trim().toUpperCase() === instrumentOutcome.trim().toUpperCase() ? 1 : 0;
}

export interface SettleableLot {
  direction: PositionDirection;
  openedShares: number;
  remainingShares: number;
  entryPrice: number;
  entryFees: number;
}

/** Settlement PnL for the remaining shares of one lot, with entry fees
 * allocated pro rata to the still-open fraction. */
export function lotSettlementPnl(lot: SettleableLot, payout: 0 | 1): number {
  if (lot.remainingShares <= 0) return 0;
  const allocatedFees = lot.entryFees * (lot.remainingShares / lot.openedShares);
  return settlementPnl(lot.direction, lot.remainingShares, lot.entryPrice, payout, allocatedFees, 0);
}

/** An invalidated market refunds collateral but the entry fees are sunk. */
export function lotInvalidationPnl(lot: SettleableLot): number {
  if (lot.remainingShares <= 0) return 0;
  return -(lot.entryFees * (lot.remainingShares / lot.openedShares));
}
