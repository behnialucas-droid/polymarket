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
  size: number;
  timestamp: string; // ISO
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
  timeToResolutionHours?: number;
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
