/** Wallet scoring: ROI, consistency, copyability, one-hit-wonder penalty, category edge. */
import type { WalletTrade, MarketData } from '../adapters/types.ts';

export interface TradeWithMarket {
  trade: WalletTrade;
  market: MarketData;
  /** realized pnl for resolved markets, per $1 staked */
  pnlPerDollar?: number;
}

export interface WalletScore {
  roi30d: number;
  consistencyScore: number; // 0..1
  copyabilityScore: number; // 0..1
  oneHitWonderPenalty: number; // 0..1 (0 = no penalty)
  globalScore: number; // 0..1
  bestCategory: string | null;
  categoryStrengths: Record<string, number>;
  averageTradeSize: number;
  tradeCount30d: number;
  resolvedTradeCount30d: number;
  winRate30d: number;
  averageLiquidity: number;
  averageSpread: number;
  averageEntryTiming: number; // hours before resolution at entry (bigger = earlier)
  copyabilityNotes: string;
  riskNotes: string;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function scoreWallet(items: TradeWithMarket[]): WalletScore {
  const trades = items.map((i) => i.trade);
  const resolved = items.filter((i) => i.pnlPerDollar !== undefined);
  const pnls = resolved.map((i) => (i.pnlPerDollar ?? 0) * i.trade.size);
  const totalStaked = trades.reduce((a, t) => a + t.size, 0) || 1;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const roi30d = totalPnl / totalStaked;

  // consistency: fraction of resolved trades profitable, damped by variance
  const wins = resolved.filter((i) => (i.pnlPerDollar ?? 0) > 0).length;
  const winRate30d = resolved.length ? wins / resolved.length : 0;
  const mean = avg(pnls);
  const variance = avg(pnls.map((p) => (p - mean) ** 2));
  const volPenalty = clamp(Math.sqrt(variance) / (Math.abs(mean) + 10), 0, 0.5);
  const consistencyScore = clamp(winRate30d * (1 - volPenalty));

  // one-hit-wonder: share of total positive pnl from single best trade
  const positive = pnls.filter((p) => p > 0);
  const best = positive.length ? Math.max(...positive) : 0;
  const posSum = positive.reduce((a, b) => a + b, 0);
  let oneHitWonderPenalty = 0;
  if (posSum > 0 && totalPnl > 0) {
    const share = best / posSum;
    if (share > 0.5) oneHitWonderPenalty = clamp((share - 0.5) * 2); // >50% from one trade starts penalizing
  }
  if (resolved.length > 0 && resolved.length < 5) oneHitWonderPenalty = clamp(oneHitWonderPenalty + 0.3); // few resolved trades = unreliable

  // copyability: liquidity, spread, entry timing (can we realistically follow?)
  const liqs = items.map((i) => i.market.liquidity ?? 0);
  const spreads = items.map((i) => i.market.spread ?? 0.1);
  const timings = items.map((i) => i.market.timeToResolutionHours ?? 0);
  const averageLiquidity = avg(liqs);
  const averageSpread = avg(spreads);
  const averageEntryTiming = avg(timings);
  const liqScore = clamp(Math.log10(averageLiquidity + 1) / 5); // 100k liquidity -> 1.0
  const spreadScore = clamp(1 - averageSpread / 0.1); // 10c spread -> 0
  const timingScore = clamp(averageEntryTiming / (24 * 7)); // entering a week early -> 1.0
  const copyabilityScore = clamp(liqScore * 0.45 + spreadScore * 0.35 + timingScore * 0.2);

  // category strengths: pnl by category (normalized 0..1)
  const byCat: Record<string, number> = {};
  for (const i of resolved) {
    const c = i.trade.marketCategory ?? 'unknown';
    byCat[c] = (byCat[c] ?? 0) + (i.pnlPerDollar ?? 0) * i.trade.size;
  }
  const catMax = Math.max(1, ...Object.values(byCat).map(Math.abs));
  const categoryStrengths = Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, Math.round((v / catMax) * 100) / 100]));
  const bestCategory = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const roiScore = clamp((roi30d + 0.2) / 0.6); // -20%..+40% ROI mapped 0..1
  const freqScore = clamp(trades.length / 20);
  const globalScore = clamp(
    (roiScore * 0.3 + consistencyScore * 0.25 + copyabilityScore * 0.25 + freqScore * 0.2) * (1 - oneHitWonderPenalty * 0.6),
  );

  const notes: string[] = [];
  if (averageSpread > 0.05) notes.push('spreads usually wide');
  if (averageLiquidity < 1000) notes.push('trades often illiquid');
  if (oneHitWonderPenalty > 0.3) notes.push('profit concentrated in one trade');
  if (resolved.length < 5) notes.push('few resolved trades');

  return {
    roi30d: Math.round(roi30d * 10000) / 10000,
    consistencyScore: Math.round(consistencyScore * 100) / 100,
    copyabilityScore: Math.round(copyabilityScore * 100) / 100,
    oneHitWonderPenalty: Math.round(oneHitWonderPenalty * 100) / 100,
    globalScore: Math.round(globalScore * 100) / 100,
    bestCategory,
    categoryStrengths,
    averageTradeSize: Math.round(avg(trades.map((t) => t.size)) * 100) / 100,
    tradeCount30d: trades.length,
    resolvedTradeCount30d: resolved.length,
    winRate30d: Math.round(winRate30d * 100) / 100,
    averageLiquidity: Math.round(averageLiquidity),
    averageSpread: Math.round(averageSpread * 1000) / 1000,
    averageEntryTiming: Math.round(averageEntryTiming),
    copyabilityNotes: notes.join('; ') || 'no copyability concerns detected',
    riskNotes: oneHitWonderPenalty > 0.5 ? 'high one-hit-wonder risk' : '',
  };
}

/** track / watch / ignore decision from score + rules thresholds */
export function walletStatus(s: WalletScore, minGlobalScore: number): { status: 'track' | 'watch' | 'ignore'; reason: string } {
  if (s.globalScore >= minGlobalScore && s.oneHitWonderPenalty < 0.5 && s.copyabilityScore >= 0.4) {
    return { status: 'track', reason: `global score ${s.globalScore} above threshold ${minGlobalScore}, copyable` };
  }
  if (s.globalScore >= minGlobalScore * 0.7) {
    return { status: 'watch', reason: `borderline score ${s.globalScore}; ${s.copyabilityNotes}` };
  }
  return { status: 'ignore', reason: `weak score ${s.globalScore}; ${s.copyabilityNotes}` };
}
