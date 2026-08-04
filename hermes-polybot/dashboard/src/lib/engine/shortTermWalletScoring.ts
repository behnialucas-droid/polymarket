// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/**
 * Short-term-only wallet scoring — the epoch rebuild criteria.
 *
 * Pure module: the clock is always a parameter (same rule as horizon.ts), so a
 * wallet's score at time T is reproducible and can never leak information from
 * after T. Only trades that satisfy ALL of the following count:
 *
 *   1. capital committed <= maxHours (entry timestamp -> absolute deadline);
 *   2. market resolution is CONFIRMED (resolved flag + concrete outcome);
 *   3. the market's deadline is at or before scoring time (no-lookahead: a market
 *      that ends after T cannot have a resolution that existed at T).
 *
 * Below the minimum sample the score is INVALID (null), never a default pass —
 * an unproven wallet is excluded from the copy universe, not guessed at.
 */
import type { TradeWithMarket } from './walletScoring.ts';
import { holdHours, DEFAULT_SHORT_TERM_MAX_HOURS } from './horizon.ts';

export const SHORT_TERM_MIN_TRADES_DEFAULT = 10;
export const RECENCY_HALF_LIFE_DAYS_DEFAULT = 14;

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const round4 = (x: number) => Math.round(x * 10000) / 10000;

export interface ShortTermScoreConfig {
  maxHours: number;
  minTrades: number;
  recencyHalfLifeDays: number;
}

export const DEFAULT_SHORT_TERM_SCORE_CONFIG: ShortTermScoreConfig = {
  maxHours: DEFAULT_SHORT_TERM_MAX_HOURS,
  minTrades: SHORT_TERM_MIN_TRADES_DEFAULT,
  recencyHalfLifeDays: RECENCY_HALF_LIFE_DAYS_DEFAULT,
};

export interface ShortTermWalletScore {
  /** false when the resolved short-term sample is below minTrades. */
  valid: boolean;
  shortTermTradeCount: number;
  /** recency+stake weighted fraction of winning trades (0..1); 0 when no sample. */
  shortTermWinRate: number;
  /** recency+stake weighted realized pnl per $1 staked. */
  shortTermPnlPerDollar: number;
  /** mean recency weight of counted trades (1 = all just happened). */
  shortTermRecencyWeight: number;
  /** composite 0..1 copy score; null when invalid (fail-closed). */
  shortTermCopyScore: number | null;
  notes: string;
}

/** True when this trade is a confirmed short-term data point usable at scoringTimeMs. */
export function isConfirmedShortTermResolved(
  item: TradeWithMarket,
  scoringTimeMs: number,
  maxHours: number,
): boolean {
  const m = item.market;
  if (m.resolved !== true || !m.resolvedOutcome) return false;
  if (!m.endDateIso) return false;
  const endMs = new Date(m.endDateIso).getTime();
  if (!Number.isFinite(endMs) || endMs > scoringTimeMs) return false; // no lookahead
  const h = holdHours(item.trade.timestamp, m);
  if (h === undefined) return false;
  return h > 0 && h <= maxHours;
}

export function scoreShortTermWallet(
  items: TradeWithMarket[],
  scoringTimeMs: number,
  config: ShortTermScoreConfig = DEFAULT_SHORT_TERM_SCORE_CONFIG,
): ShortTermWalletScore {
  const counted = items.filter((i) => isConfirmedShortTermResolved(i, scoringTimeMs, config.maxHours));

  if (counted.length < config.minTrades) {
    return {
      valid: false,
      shortTermTradeCount: counted.length,
      shortTermWinRate: 0,
      shortTermPnlPerDollar: 0,
      shortTermRecencyWeight: 0,
      shortTermCopyScore: null,
      notes: `insufficient resolved short-term sample (${counted.length} < ${config.minTrades})`,
    };
  }

  const halfLifeMs = config.recencyHalfLifeDays * 864e5;
  let weightSum = 0;
  let winWeight = 0;
  let pnlWeighted = 0;
  let recencySum = 0;

  for (const i of counted) {
    const tradeMs = new Date(i.trade.timestamp).getTime();
    const ageMs = Math.max(0, scoringTimeMs - tradeMs);
    const recency = Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
    const stake = Math.max(0, i.trade.notionalUsd ?? i.trade.size) || 0;
    const w = recency * stake;
    if (w <= 0) continue;
    const pnlPerDollar = i.pnlPerDollar ?? 0;
    weightSum += w;
    recencySum += recency;
    if (pnlPerDollar > 0) winWeight += w;
    pnlWeighted += w * pnlPerDollar;
  }

  if (weightSum <= 0) {
    return {
      valid: false,
      shortTermTradeCount: counted.length,
      shortTermWinRate: 0,
      shortTermPnlPerDollar: 0,
      shortTermRecencyWeight: 0,
      shortTermCopyScore: null,
      notes: 'all counted trades carry zero stake weight',
    };
  }

  const winRate = winWeight / weightSum;
  const pnlPerDollar = pnlWeighted / weightSum;
  const recencyMean = recencySum / counted.length;

  // pnl/$1 mapped -20%..+40% onto 0..1 (same band the legacy roiScore used).
  const pnlScore = clamp((pnlPerDollar + 0.2) / 0.6);
  const copyScore = clamp(winRate * 0.45 + pnlScore * 0.35 + recencyMean * 0.2);

  return {
    valid: true,
    shortTermTradeCount: counted.length,
    shortTermWinRate: round4(winRate),
    shortTermPnlPerDollar: round4(pnlPerDollar),
    shortTermRecencyWeight: round4(recencyMean),
    shortTermCopyScore: round4(copyScore),
    notes: '',
  };
}

/** Deterministic top-N selection: score descending, ties broken by ascending address. */
export function selectTopWallets<T extends { address: string; shortTermCopyScore: number }>(
  candidates: T[],
  limit: number,
): T[] {
  return [...candidates]
    .sort((a, b) =>
      b.shortTermCopyScore !== a.shortTermCopyScore
        ? b.shortTermCopyScore - a.shortTermCopyScore
        : a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
    )
    .slice(0, Math.max(0, limit));
}
