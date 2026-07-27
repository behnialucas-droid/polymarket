/**
 * Wallet Classification — Foundation v2 Phase 4 §6.7
 *
 * Deterministic rules turning a WalletProfile into a status label:
 *   'copy'   — monitored every cycle; signals become paper positions
 *   'watch'  — monitored every cycle; signals recorded, not traded
 *   'ignore' — not monitored; re-evaluated next generation
 *
 * This function MUST be pure: same input → same output.
 * No clock reads (no Date.now()), no random numbers, no DB reads.
 * It is rendered into git and diffed across generations;
 * non-determinism creates phantom git diffs forever.
 */

export type MemoryStatus = 'copy' | 'watch' | 'ignore';

export interface Decision {
  status: MemoryStatus;
  reason: string;
}

export interface ClassificationProfileInput {
  address: string;
  globalScore: number;
  tradeCount30d: number;
  resolvedTradeCount30d?: number;
  realizedPnl30d: number;
  consistency: number;
  maxDrawdown30d: number;
  daysSinceLastTrade: number;
  oneHitWonderFlag: boolean;
  topTradePnlShare: number;
}

/**
 * Classify a wallet based on its 30-day performance profile.
 *
 * @param p         The wallet performance profile metrics
 * @param previous  The wallet's status in the previous generation (for hysteresis)
 */
export function classify(
  p: ClassificationProfileInput,
  previous?: MemoryStatus
): Decision {
  const r: string[] = [];

  // --- 1. Hard disqualifiers, evaluated first, in fixed order ---
  if (p.tradeCount30d < 5) {
    return { status: 'ignore', reason: `only ${p.tradeCount30d} trades in 30d` };
  }
  if (p.daysSinceLastTrade > 21) {
    return { status: 'ignore', reason: `inactive ${p.daysSinceLastTrade}d` };
  }
  if (p.realizedPnl30d <= 0) {
    return { status: 'ignore', reason: 'negative 30d PnL' };
  }
  if (p.oneHitWonderFlag) {
    return {
      status: 'watch',
      reason: `single trade drives ${(p.topTradePnlShare * 100).toFixed(0)}% of PnL`,
    };
  }

  // --- 2. Positive gates (all must hold for copy) ---
  const gates: Array<readonly [boolean, string]> = [
    [p.globalScore >= 70, `score ${p.globalScore.toFixed(1)} < 70`],
    [p.tradeCount30d >= 10, `sample ${p.tradeCount30d} < 10`],
    [p.consistency >= 0.55, `consistency ${p.consistency.toFixed(2)} < 0.55`],
    [p.maxDrawdown30d <= 0.35, `drawdown ${(p.maxDrawdown30d * 100).toFixed(0)}% > 35%`],
    [p.daysSinceLastTrade <= 7, `last trade ${p.daysSinceLastTrade}d ago`],
  ];

  for (const [ok, why] of gates) {
    if (!ok) r.push(why);
  }

  // --- 3. Hysteresis: promote at 70, demote only below 65 ---
  // A wallet oscillating at 69.8 would otherwise flip copy/watch every
  // generation, churning both the git diff and the monitored set.
  if (previous === 'copy' && r.length <= 1 && p.globalScore >= 65) {
    return {
      status: 'copy',
      reason: `retained (hysteresis): ${r.join('; ') || 'all gates pass'}`,
    };
  }

  if (r.length === 0) {
    return {
      status: 'copy',
      reason: `score ${p.globalScore.toFixed(1)}, ${p.tradeCount30d} trades, consistency ${p.consistency.toFixed(2)}`,
    };
  }

  if (r.length <= 2 && p.globalScore >= 55) {
    return { status: 'watch', reason: r.join('; ') };
  }

  return { status: 'ignore', reason: r.join('; ') };
}
