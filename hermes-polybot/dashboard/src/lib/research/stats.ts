// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Dependency-free research statistics. Everything is deterministic under a
 * fixed seed so a preregistered analysis is exactly reproducible. Inputs are
 * plain numbers (USD); these are measurements over recorded ledger data, they
 * never feed back into accounting. */

/** mulberry32 — small deterministic PRNG, good enough for bootstrap resampling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function mean(values: number[]): number {
  if (!values.length) throw new Error('mean of empty series');
  return sum(values) / values.length;
}

/** Empirical percentile with linear interpolation, p in [0, 1]. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) throw new Error('percentile of empty series');
  if (p < 0 || p > 1) throw new Error(`percentile p out of [0,1]: ${p}`);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Max drawdown of the cumulative-sum equity path of a PnL series. */
export function maxDrawdown(pnlSeries: number[]): number {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const pnl of pnlSeries) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > worst) worst = drawdown;
  }
  return worst;
}

export interface BootstrapResult {
  seed: number;
  resamples: number;
  blockLength: number;
  observedTotal: number;
  ciLow: number;
  ciHigh: number;
  /** Fraction of resampled totals that are <= 0. */
  probabilityOfLoss: number;
}

/** Circular block bootstrap over a daily net-PnL series.
 * Blocks preserve short-horizon autocorrelation; the circle removes edge bias.
 * Returns a percentile CI for the TOTAL over the same horizon as the input. */
export function blockBootstrapTotal(
  dailyPnl: number[],
  options: { seed: number; resamples?: number; blockLength?: number; ciLevel?: number } ,
): BootstrapResult {
  const n = dailyPnl.length;
  if (n < 2) throw new Error(`bootstrap needs at least 2 observations, got ${n}`);
  for (const value of dailyPnl) {
    if (!Number.isFinite(value)) throw new Error('bootstrap input contains a non-finite value');
  }
  const resamples = options.resamples ?? 10_000;
  const blockLength = Math.max(1, Math.min(options.blockLength ?? 3, n));
  const ciLevel = options.ciLevel ?? 0.95;
  if (ciLevel <= 0 || ciLevel >= 1) throw new Error(`ciLevel out of (0,1): ${ciLevel}`);
  const rand = mulberry32(options.seed);

  const totals = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let total = 0;
    let filled = 0;
    while (filled < n) {
      const start = Math.floor(rand() * n);
      const take = Math.min(blockLength, n - filled);
      for (let k = 0; k < take; k++) {
        total += dailyPnl[(start + k) % n];
      }
      filled += take;
    }
    totals[r] = total;
  }
  totals.sort((a, b) => a - b);
  const alpha = (1 - ciLevel) / 2;
  let losses = 0;
  for (const t of totals) if (t <= 0) losses++;
  return {
    seed: options.seed,
    resamples,
    blockLength,
    observedTotal: sum(dailyPnl),
    ciLow: percentile(totals, alpha),
    ciHigh: percentile(totals, 1 - alpha),
    probabilityOfLoss: losses / resamples,
  };
}
