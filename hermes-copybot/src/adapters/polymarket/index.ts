// Polymarket public API adapters. NO KEYS NEEDED. Read-only.
// On any HTTP failure: throw with real status + body. Never fabricate data.

import type {
    Adapters,
    LeaderboardAdapter,
    LeaderboardEntry,
    MarketAdapter,
    MarketInfo,
    OutcomeAdapter,
    PriceAdapter,
    TradeAdapter,
    WalletActivity,
} from '../types.ts';

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

async function getJson(url: string): Promise<unknown> {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        throw new Error(`Polymarket API error: ${res.status} ${res.statusText} for ${url}\n${body}`);
    }
    return res.json();
}

export const polymarketLeaderboard: LeaderboardAdapter = {
    async fetchLeaderboard(limit, lookbackDays): Promise<LeaderboardEntry[]> {
        // Public leaderboard endpoint. window: day|week|month|all
        const window = lookbackDays <= 7 ? 'week' : 'month';
        const out: LeaderboardEntry[] = [];
        const pageSize = 100;
        for (let offset = 0; out.length < limit; offset += pageSize) {
            const url = `${DATA_API}/leaderboard?window=${window}&limit=${pageSize}&offset=${offset}&rankType=pnl`;
            const data = (await getJson(url)) as Array<Record<string, unknown>>;
            if (!Array.isArray(data) || data.length === 0) break;
            for (const row of data) {
                out.push({
                    address: String(row.proxyWallet ?? row.walletAddress ?? row.address ?? ''),
                    label: (row.name as string) || (row.userName as string) || undefined,
                    rank: out.length + 1,
                    pnl: Number(row.amount ?? row.pnl ?? 0),
                    volume: Number(row.volume ?? 0),
                });
                if (out.length >= limit) break;
            }
            if (data.length < pageSize) break;
        }
        return out;
    },
};

export const polymarketTrades: TradeAdapter = {
    async fetchWalletActivity(address, sinceIso): Promise<WalletActivity[]> {
        const sinceTs = Math.floor(new Date(sinceIso).getTime() / 1000);
        const url = `${DATA_API}/activity?user=${address}&type=TRADE&limit=500&start=${sinceTs}`;
        const data = (await getJson(url)) as Array<Record<string, unknown>>;
        if (!Array.isArray(data)) return [];
        return data.map((t) => ({
            walletAddress: address,
            marketId: String(t.conditionId ?? t.market ?? ''),
            conditionId: t.conditionId ? String(t.conditionId) : undefined,
            marketQuestion: (t.title as string) ?? undefined,
            marketCategory: (t.eventSlug as string)?.split('-')[0] ?? undefined,
            outcome: (t.outcome as string)?.toUpperCase() ?? undefined,
            side: (t.side as string)?.toUpperCase() ?? undefined,
            price: Number(t.price ?? 0),
            size: Number(t.usdcSize ?? t.size ?? 0),
            timestamp: new Date(Number(t.timestamp) * 1000).toISOString(),
            raw: t,
        }));
    },
};

export const polymarketMarkets: MarketAdapter = {
    async fetchMarket(marketId): Promise<MarketInfo> {
        // marketId here is the conditionId; gamma supports lookup by condition_ids
        const url = `${GAMMA_API}/markets?condition_ids=${marketId}`;
        const data = (await getJson(url)) as Array<Record<string, unknown>>;
        const m = Array.isArray(data) ? data[0] : undefined;
        if (!m) throw new Error(`Polymarket API error: market not found for conditionId ${marketId}`);
        const prices = safeParseArray(m.outcomePrices);
        const yesPrice = prices ? Number(prices[0]) : undefined;
        const noPrice = prices ? Number(prices[1]) : undefined;
        const bestBid = m.bestBid != null ? Number(m.bestBid) : undefined;
        const bestAsk = m.bestAsk != null ? Number(m.bestAsk) : undefined;
        return {
            marketId,
            conditionId: marketId,
            question: (m.question as string) ?? undefined,
            category: (m.category as string) ?? undefined,
            yesPrice,
            noPrice,
            bestBid,
            bestAsk,
            spread: bestBid != null && bestAsk != null ? Math.round((bestAsk - bestBid) * 1000) / 1000 : undefined,
            liquidity: m.liquidityNum != null ? Number(m.liquidityNum) : Number(m.liquidity ?? 0),
            volume: m.volumeNum != null ? Number(m.volumeNum) : Number(m.volume ?? 0),
            endDate: (m.endDate as string) ?? undefined,
            resolved: Boolean(m.closed) && m.umaResolutionStatus === 'resolved',
            resolvedOutcome:
                yesPrice != null && Boolean(m.closed) ? (yesPrice > 0.5 ? 'YES' : 'NO') : undefined,
            raw: m,
        };
    },
};

function safeParseArray(v: unknown): unknown[] | null {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

export const polymarketPrices: PriceAdapter = {
    async fetchPrice(marketId, outcome) {
        // Use gamma market prices (mid) — CLOB token-level books need token ids; gamma is sufficient for paper pnl.
        const info = await polymarketMarkets.fetchMarket(marketId);
        const price = outcome === 'NO' ? info.noPrice : info.yesPrice;
        if (price == null || Number.isNaN(price)) {
            throw new Error(`Polymarket API error: no price for market ${marketId} outcome ${outcome}`);
        }
        return { price, bestBid: info.bestBid, bestAsk: info.bestAsk };
    },
};

export const polymarketOutcomes: OutcomeAdapter = {
    async fetchOutcome(marketId) {
        const info = await polymarketMarkets.fetchMarket(marketId);
        return { resolved: Boolean(info.resolved), winningOutcome: info.resolvedOutcome };
    },
};

export const polymarketAdapters: Adapters = {
    source: 'polymarket',
    leaderboard: polymarketLeaderboard,
    trades: polymarketTrades,
    markets: polymarketMarkets,
    prices: polymarketPrices,
    outcomes: polymarketOutcomes,
};

export { CLOB_API }; // exported for reference; CLOB order endpoints intentionally NOT used (read-only app)
