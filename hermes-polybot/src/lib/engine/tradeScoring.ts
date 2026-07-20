/** Per-trade scoring: paper_copy | watchlist | skip, with reasons + risks. */
import type { MarketData, WalletTrade } from '../adapters/types.ts';
import type { Rules } from './rules.ts';

export interface TradeDecision {
  decision: 'paper_copy' | 'watchlist' | 'skip';
  copyScore: number;
  confidence: number;
  reasons: string[];
  risks: string[];
  scores: {
    walletQualityScore: number;
    roiScore: number;
    consistencyScore: number;
    copyabilityScore: number;
    categoryFitScore: number;
    entryTimingScore: number;
    spreadScore: number;
    liquidityScore: number;
    thesisScore: number;
  };
  simulatedPositionSize: number | null;
}

export interface WalletContext {
  globalScore: number;
  roi30d: number;
  consistencyScore: number;
  copyabilityScore: number;
  bestCategory: string | null;
  categoryStrengths: Record<string, number>;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

export function scoreTrade(trade: WalletTrade, market: MarketData, wallet: WalletContext, rules: Rules): TradeDecision {
  const reasons: string[] = [];
  const risks: string[] = [];

  const currentPrice = trade.outcome?.toUpperCase() === 'NO' ? (market.noPrice ?? 0.5) : (market.yesPrice ?? 0.5);
  const priceMove = currentPrice - trade.price;
  const spread = market.spread ?? 0.1;
  const liquidity = market.liquidity ?? 0;
  const ttr = market.timeToResolutionHours ?? Infinity;

  const walletQualityScore = clamp(wallet.globalScore);
  const roiScore = clamp((wallet.roi30d + 0.2) / 0.6);
  const consistencyScore = clamp(wallet.consistencyScore);
  const copyabilityScore = clamp(wallet.copyabilityScore);
  const categoryFitScore = clamp(trade.marketCategory && wallet.categoryStrengths[trade.marketCategory] !== undefined
    ? (wallet.categoryStrengths[trade.marketCategory] + 1) / 2
    : 0.5);
  const entryTimingScore = clamp(1 - Math.abs(priceMove) / rules.maxPriceMoveSinceEntry);
  const spreadScore = clamp(1 - spread / rules.maxSpread / 2);
  const liquidityScore = clamp(liquidity / (rules.minLiquidity * 4));
  // thesis clarity: proxy = trade is BUY on a wallet's strong category with sane price
  const thesisScore = clamp(
    (trade.side === 'BUY' ? 0.6 : 0.3) + (trade.marketCategory === wallet.bestCategory ? 0.3 : 0) + (currentPrice > 0.1 && currentPrice < 0.9 ? 0.1 : 0),
  );

  const w = rules.weights;
  const copyScore = clamp(
    walletQualityScore * w.roi + // wallet quality weighted under roi slot per spec weight list
      roiScore * 0 +
      consistencyScore * w.consistency +
      copyabilityScore * w.copyability +
      categoryFitScore * w.categoryFit +
      entryTimingScore * w.entryTiming +
      spreadScore * w.spread +
      liquidityScore * w.liquidity +
      thesisScore * w.thesis +
      walletQualityScore * (1 - w.roi - w.consistency - w.copyability - w.categoryFit - w.entryTiming - w.spread - w.liquidity - w.thesis),
  );

  // Hard gates
  let gated: 'skip' | null = null;
  if (liquidity < rules.minLiquidity) { gated = 'skip'; risks.push(`liquidity ${liquidity} below minimum ${rules.minLiquidity}`); }
  if (spread > rules.maxSpread) { gated = 'skip'; risks.push(`spread ${spread.toFixed(3)} above maximum ${rules.maxSpread}`); }
  if (Math.abs(priceMove) > rules.maxPriceMoveSinceEntry) { gated = 'skip'; risks.push(`price moved ${priceMove.toFixed(3)} since wallet entry (limit ${rules.maxPriceMoveSinceEntry})`); }
  if (wallet.globalScore < rules.minWalletGlobalScore) { gated = 'skip'; risks.push(`wallet global score ${wallet.globalScore} below minimum ${rules.minWalletGlobalScore}`); }
  if (ttr > rules.maxTimeToResolutionHours) { gated = 'skip'; risks.push(`resolution too far out (${Math.round(ttr)}h)`); }
  if (market.resolved) { gated = 'skip'; risks.push('market already resolved'); }

  let decision: TradeDecision['decision'];
  if (gated) decision = 'skip';
  else if (copyScore >= rules.minCopyScore) { decision = 'paper_copy'; reasons.push(`copy score ${copyScore.toFixed(2)} above copy threshold ${rules.minCopyScore}`); }
  else if (copyScore >= rules.minWatchScore) { decision = 'watchlist'; reasons.push(`copy score ${copyScore.toFixed(2)} in watch range`); }
  else { decision = 'skip'; reasons.push(`copy score ${copyScore.toFixed(2)} below watch threshold ${rules.minWatchScore}`); }

  if (decision !== 'skip') {
    if (spread > rules.maxSpread * 0.7) risks.push('spread near limit');
    if (priceMove > 0) risks.push(`entering ${priceMove.toFixed(3)} above wallet entry`);
    reasons.push(`wallet quality ${walletQualityScore}, liquidity ${liquidity}, spread ${spread.toFixed(3)}`);
  }

  const confidence = clamp((copyScore - rules.minCopyScore) / (1 - rules.minCopyScore));
  // $5–$20 sized by confidence
  const simulatedPositionSize = decision === 'paper_copy' ? Math.round((5 + confidence * 15) * 100) / 100 : null;

  return {
    decision, copyScore: Math.round(copyScore * 100) / 100, confidence: Math.round(confidence * 100) / 100,
    reasons, risks,
    scores: { walletQualityScore, roiScore, consistencyScore, copyabilityScore, categoryFitScore, entryTimingScore, spreadScore, liquidityScore, thesisScore },
    simulatedPositionSize,
  };
}
