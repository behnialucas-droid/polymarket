/** Live Polymarket adapter — public read-only GET endpoints only.
 * gamma-api.polymarket.com  : market metadata
 * data-api.polymarket.com   : leaderboard + wallet activity
 * clob.polymarket.com       : prices/books (public, no auth)
 * NO order endpoints, NO auth, NO keys. Fails loud with real error. */
import { AdapterError, type DataAdapter, type LeaderboardEntry, type MarketData, type WalletTrade } from './types.ts';
import { getJson as _getJson } from './http.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/**
 * Thin wrapper: converts http.ts errors into AdapterError for backward compat.
 * The actual rate-limiting, retries, and timeouts live in http.ts + rateLimit.ts.
 */
async function getJson(url: string): Promise<any> {

  try {
    return await _getJson(url);
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    throw new AdapterError(msg);
  }
}

export class PolymarketAdapter implements DataAdapter {
  readonly source = 'polymarket';
  readonly isDemo = false;

  async fetchLeaderboard(limit = 500): Promise<LeaderboardEntry[]> {
    const out: LeaderboardEntry[] = [];
    for (let offset = 0; out.length < limit; offset += 100) {
      try {
        const page = await getJson(`${DATA}/v1/leaderboard?timePeriod=month&orderBy=PNL&category=overall&limit=100&offset=${offset}`);
        const rows: any[] = Array.isArray(page) ? page : (page?.leaderboard ?? []);
        if (!rows.length) break;
        for (const r of rows) {
          out.push({
            address: String(r.proxyWallet ?? r.address ?? r.wallet ?? r.user ?? ''),
            label: r.userName ?? r.name ?? r.pseudonym ?? undefined,
            rank: out.length + 1,
            pnl: Number(r.pnl ?? r.amount ?? r.profit ?? 0),
            volume: Number(r.vol ?? r.volume ?? 0),
          });
          if (out.length >= limit) break;
        }
      } catch {
        break;
      }
    }
    return out.filter((e) => Boolean(e.address));
  }

  async fetchWalletTrades(address: string, sinceIso: string): Promise<WalletTrade[]> {
    const sinceTs = Math.floor(new Date(sinceIso).getTime() / 1000);
    let rows: any[] = [];
    try {
      rows = await getJson(`${DATA}/activity?user=${address}&type=TRADE&limit=500&start=${sinceTs}`);
    } catch {
      rows = await getJson(`${DATA}/activity?user=${address}&type=TRADE&limit=100&start=${sinceTs}`);
    }
    const observedAt = new Date().toISOString();
    return (rows ?? [])
      .filter((t) => Number(t.timestamp) >= sinceTs)
      .map((t) => {
        const side = String(t.side ?? '').toUpperCase();
        if (side !== 'BUY' && side !== 'SELL') throw new AdapterError(`Unsupported trade side: ${String(t.side)}`);
        const quantityShares = Number(t.size);
        const notionalUsd = Number(t.usdcSize);
        const price = Number(t.price);
        if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new AdapterError('Trade has invalid price');
        if (!Number.isFinite(quantityShares) || quantityShares <= 0) throw new AdapterError('Trade has invalid share quantity');
        if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) throw new AdapterError('Trade has invalid USDC notional');
        return {
          walletAddress: address,
          marketId: String(t.market ?? t.conditionId ?? ''),
          conditionId: t.conditionId,
          marketQuestion: t.title ?? t.question,
          marketCategory: t.eventSlug ?? t.category,
          outcome: t.outcome,
          side,
          price,
          size: notionalUsd,
          quantityShares,
          notionalUsd,
          providerEventId: t.id == null ? undefined : String(t.id),
          transactionHash: t.transactionHash == null ? undefined : String(t.transactionHash),
          assetId: t.asset == null ? undefined : String(t.asset),
          outcomeIndex: Number.isInteger(Number(t.outcomeIndex)) ? Number(t.outcomeIndex) : undefined,
          timestamp: new Date(Number(t.timestamp) * 1000).toISOString(),
          observedAt,
          raw: t,
        };
      });
  }

  async fetchMarket(marketId: string): Promise<MarketData> {
    let data = await getJson(`${GAMMA}/markets?condition_ids=${marketId}`);
    let m = Array.isArray(data) ? data[0] : undefined;
    if (!m) {
      data = await getJson(`${GAMMA}/markets?condition_ids=${marketId}&closed=true&archived=true`);
      m = Array.isArray(data) ? data[0] : undefined;
    }
    if (!m) throw new AdapterError(`Market not found: ${marketId}`);
    const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
    const yes = Number(prices[0] ?? m.bestAsk ?? 0);
    const bid = Number(m.bestBid ?? 0);
    const ask = Number(m.bestAsk ?? 0);
    return {
      marketId: String(m.id ?? marketId),
      conditionId: m.conditionId,
      question: m.question,
      category: m.category,
      yesPrice: yes,
      noPrice: yes ? 1 - yes : undefined,
      bestBid: bid,
      bestAsk: ask,
      spread: ask && bid ? ask - bid : undefined,
      liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
      volume: Number(m.volumeNum ?? m.volume ?? 0),
      endDateIso: m.endDate ?? undefined,
      slug: m.slug ?? m.eventSlug ?? undefined,
      timeToResolutionHours: m.endDate ? (new Date(m.endDate).getTime() - Date.now()) / 3.6e6 : undefined,
      resolved: Boolean(m.closed),
      resolvedOutcome: (() => {
        const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : [];
        const outcomes = m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : [];
        if (m.closed && prices.length >= 2 && outcomes.length >= 2) {
          const winIdx = prices.findIndex((p: any) => Number(p) > 0.85);
          if (winIdx >= 0 && outcomes[winIdx]) return String(outcomes[winIdx]);
        }
        return m.umaResolutionStatus === 'resolved' ? (m.outcome ?? undefined) : undefined;
      })(),
      raw: m,
    };
  }

  async fetchPrice(marketId: string, outcome?: string): Promise<number> {
    const m = await this.fetchMarket(marketId);
    if (outcome?.toUpperCase() === 'NO') return m.noPrice ?? NaN;
    return m.yesPrice ?? NaN;
  }
}
