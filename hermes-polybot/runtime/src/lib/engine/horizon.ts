/**
 * Short-term horizon — the single place that decides how long capital stays locked.
 *
 * Everything here is pure: the clock is always a parameter, never read internally.
 * That keeps wallet profiles deterministic across generations (same rule as classify.ts).
 *
 * Source of truth is the ABSOLUTE deadline (`endDateIso`). `timeToResolutionHours`
 * is only a fallback: it is computed at fetch time, so a stored value decays into a
 * lie within hours.
 */
import type { MarketData, WalletTrade } from '../adapters/types.ts';

/** Markets resolving later than this are never copied. */
export const DEFAULT_SHORT_TERM_MAX_HOURS = 24;

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/**
 * Hours from `nowMs` until the market resolves.
 * Negative means the deadline already passed (expired but not yet settled).
 * `undefined` means the market has no usable deadline at all.
 */
export function hoursToResolution(market: MarketData, nowMs: number): number | undefined {
  if (market.endDateIso) {
    const end = new Date(market.endDateIso).getTime();
    if (Number.isFinite(end)) return (end - nowMs) / 3.6e6;
  }
  if (typeof market.timeToResolutionHours === 'number' && Number.isFinite(market.timeToResolutionHours)) {
    return market.timeToResolutionHours;
  }
  return undefined;
}

/**
 * True only for markets that resolve soon AND have not already expired.
 *
 * The `h > 0` half matters as much as the ceiling: a market whose endDate has passed
 * while `closed` is still false reports a NEGATIVE horizon, which trivially satisfies
 * any `h <= max` test. Those are exactly the positions that sit open for weeks.
 */
export function isShortTerm(market: MarketData, nowMs: number, maxHours = DEFAULT_SHORT_TERM_MAX_HOURS): boolean {
  const h = hoursToResolution(market, nowMs);
  if (h === undefined) return false;
  return h > 0 && h <= maxHours;
}

/**
 * Hours the wallet's capital was committed: entry timestamp -> resolution deadline.
 * Independent of the current clock, so it stays meaningful for already-resolved
 * markets and is safe to use when profiling 30 days of history.
 */
export function holdHours(tradeTimestampIso: string, market: MarketData): number | undefined {
  if (!market.endDateIso) return undefined;
  const end = new Date(market.endDateIso).getTime();
  const start = new Date(tradeTimestampIso).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(start)) return undefined;
  return (end - start) / 3.6e6;
}

/** Fraction of a wallet's trades that were short-term commitments (0..1). */
export function shortTermShare(
  items: Array<{ trade: Pick<WalletTrade, 'timestamp'>; market: MarketData }>,
  maxHours = DEFAULT_SHORT_TERM_MAX_HOURS,
): number {
  if (items.length === 0) return 0;
  let eligible = 0;
  let short = 0;
  for (const i of items) {
    let h = holdHours(i.trade.timestamp, i.market);
    if (h === undefined && typeof i.market.timeToResolutionHours === 'number' && Number.isFinite(i.market.timeToResolutionHours)) {
      // Relative TTR is already the adapter's observation-time horizon. Use it exactly as the
      // trade gate does; neither path silently turns fallback-only records into long-term.
      h = i.market.timeToResolutionHours;
    }
    if (h === undefined) continue;
    eligible++;
    if (h > 0 && h <= maxHours) short++;
  }
  // Records with no usable horizon are excluded from both numerator and denominator.
  return eligible === 0 ? 0 : short / eligible;
}

/**
 * Subject hints for fast-resolving markets (BTC/ETH price bets, daily up-or-down, …).
 * A BONUS signal only — never a gate. Plenty of short-term markets (daily sports,
 * tonight's vote count) match none of these, and blocking on the list would silently
 * shrink the universe to crypto.
 */
export const SHORT_TERM_SUBJECTS: readonly RegExp[] = [
  /\bbtc\b/i,
  /\bbitcoin\b/i,
  /\beth\b/i,
  /\bethereum\b/i,
  /\bsol\b/i,
  /\bsolana\b/i,
  /\bxrp\b/i,
  /\bprice\b/i,
  /up[\s-]?or[\s-]?down/i,
  /\bhourly\b/i,
  /\bdaily\b/i,
  /\btoday\b/i,
  /\btonight\b/i,
  /\bclose\b/i,
];

export function isShortTermSubject(...texts: Array<string | undefined>): boolean {
  const hay = texts.filter(Boolean).join(' ');
  if (!hay) return false;
  return SHORT_TERM_SUBJECTS.some((re) => re.test(hay));
}

/**
 * 1.0 = resolving right now, 0.0 = at or beyond the ceiling.
 * Deliberately the inverse of the old wallet `timingScore`, which rewarded
 * entering a week early and therefore pulled the whole system toward long-term markets.
 */
export function horizonScore(hours: number | undefined, maxHours = DEFAULT_SHORT_TERM_MAX_HOURS): number {
  if (hours === undefined || hours <= 0) return 0;
  return clamp(1 - hours / maxHours);
}
