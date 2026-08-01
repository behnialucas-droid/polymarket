// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Adapter interfaces. READ-ONLY: adapters may only fetch public data.
 * No signing, no order placement, no private keys — ever. */

export interface LeaderboardEntry {
  address: string;
  label?: string;
  rank: number;
  pnl?: number;
  volume?: number;
}

export interface WalletTrade {
  walletAddress: string;
  marketId: string;
  conditionId?: string;
  marketQuestion?: string;
  marketCategory?: string;
  outcome?: string;
  side: 'BUY' | 'SELL';
  price: number;
  /** Legacy provider value. Consumers must not infer whether this means shares or USDC. */
  size: number;
  quantityShares?: number;
  notionalUsd?: number;
  providerEventId?: string;
  transactionHash?: string;
  assetId?: string;
  outcomeIndex?: number;
  timestamp: string; // provider event ISO
  observedAt?: string; // Hermes collection ISO
  raw?: unknown;
}

export interface MarketData {
  marketId: string;
  conditionId?: string;
  question?: string;
  category?: string;
  yesPrice?: number;
  noPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  liquidity?: number;
  volume?: number;
  /** Absolute resolution deadline (ISO). Source of truth for horizon math —
   * timeToResolutionHours decays the moment it is stored, this does not. */
  endDateIso?: string;
  /** Relative hours at fetch time. Kept for backward compat; prefer endDateIso. */
  timeToResolutionHours?: number;
  /** Event slug, e.g. "bitcoin-up-or-down-july-30" — used for short-term subject matching. */
  slug?: string;
  resolved?: boolean;
  resolvedOutcome?: string;
  raw?: unknown;
}

export interface DataAdapter {
  readonly source: string;
  readonly isDemo: boolean;
  fetchLeaderboard(limit: number): Promise<LeaderboardEntry[]>;
  fetchWalletTrades(address: string, sinceIso: string): Promise<WalletTrade[]>;
  fetchMarket(marketId: string): Promise<MarketData>;
  fetchPrice(marketId: string, outcome?: string): Promise<number>;
}

/** Thrown with the REAL upstream error. Callers must surface it and stop — never fake data. */
export class AdapterError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'AdapterError';
    this.status = status;
    this.body = body;
  }
}
