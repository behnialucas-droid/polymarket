/** Live Polymarket adapter — public read-only GET endpoints only.
 * gamma-api.polymarket.com  : market metadata
 * data-api.polymarket.com   : leaderboard + wallet activity
 * clob.polymarket.com       : prices/books (public, no auth)
 * NO order endpoints, NO auth, NO keys. Fails loud with real error. */
import { AdapterError, type DataAdapter, type LeaderboardEntry, type MarketData, type WalletTrade } from './types.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

let lastRequestTime = 0;

async function getJson(url: string, retries = 4): Promise<any> {
  let lastErr: Error | undefined;

  // Anti-suspension throttling: minimum 200ms delay between API calls
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 200) {
    await sleep(200 - elapsed);
  }
  lastRequestTime = Date.now();

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(1500 * 2 ** (attempt - 1)); // 1.5s, 3s, 6s, 12s backoff

    let res: Response;
    try {
      res = await fetch(url, { 
        method: 'GET',
        headers: { 'User-Agent': 'HermesPolybot/1.0 (Supabase-Powered Paper Trader)' }
      });
    } catch (e: any) {
      lastErr = new AdapterError(`Network error fetching ${url}: ${e?.message ?? e}`);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429) {
        // Rate limited — cool down for 5 seconds
        console.warn(`[Rate Limit] HTTP 429 received for ${url}. Cooling down for 5s...`);
        await sleep(5000);
        continue;
      }
      if (res.status === 400 || res.status === 404) {
        throw new AdapterError(`HTTP ${res.status} from ${url}`, res.status, body.slice(0, 500));
      }
      lastErr = new AdapterError(`HTTP ${res.status} from ${url}`, res.status, body.slice(0, 500));
      continue;
    }
    return res.json();
  }
  throw lastErr ?? new AdapterError(`Failed after ${retries} attempts: ${url}`);
}

export class PolymarketAdapter implements DataAdapter {
  readonly source = 'polymarket';
  readonly isDemo = false;

  async fetchLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
    const out: LeaderboardEntry[] = [];
    // data-api leaderboard uses v1/leaderboard, ranked by PNL
    for (let offset = 0; out.length < limit; offset += 100) {
      const page = await getJson(`${DATA}/v1/leaderboard?timePeriod=month&orderBy=PNL&category=overall&limit=100&offset=${offset}`);
      const rows: any[] = Array.isArray(page) ? page : (page?.leaderboard ?? []);
      if (!rows.length) break;
      for (const r of rows) {
        out.push({
          address: r.proxyWallet ?? r.address ?? r.wallet,
          label: r.userName ?? r.name ?? undefined,
          rank: out.length + 1,
          pnl: Number(r.pnl ?? r.amount ?? 0),
          volume: Number(r.vol ?? r.volume ?? 0),
        });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async fetchWalletTrades(address: string, sinceIso: string): Promise<WalletTrade[]> {
    const sinceTs = Math.floor(new Date(sinceIso).getTime() / 1000);
    // Use the activity feed filtered by TRADE type
    const rows: any[] = await getJson(`${DATA}/activity?user=${address}&type=TRADE&limit=500&start=${sinceTs}`);
    return (rows ?? [])
      .filter((t) => Number(t.timestamp) >= sinceTs)
      .map((t) => ({
        walletAddress: address,
        marketId: String(t.market ?? t.conditionId ?? ''),
        conditionId: t.conditionId,
        marketQuestion: t.title ?? t.question,
        marketCategory: t.eventSlug ?? t.category,
        outcome: t.outcome,
        side: (t.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        price: Number(t.price),
        size: Number(t.usdcSize ?? t.size ?? 0),
        timestamp: new Date(Number(t.timestamp) * 1000).toISOString(),
        raw: t,
      }));
  }

  async fetchMarket(marketId: string): Promise<MarketData> {
    const data = await getJson(`${GAMMA}/markets?condition_ids=${marketId}`);
    const m = Array.isArray(data) ? data[0] : undefined;
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
      timeToResolutionHours: m.endDate ? (new Date(m.endDate).getTime() - Date.now()) / 3.6e6 : undefined,
      resolved: Boolean(m.closed),
      resolvedOutcome: m.umaResolutionStatus === 'resolved' ? (m.outcome ?? undefined) : undefined,
      raw: m,
    };
  }

  async fetchPrice(marketId: string, outcome?: string): Promise<number> {
    const m = await this.fetchMarket(marketId);
    if (outcome?.toUpperCase() === 'NO') return m.noPrice ?? NaN;
    return m.yesPrice ?? NaN;
  }
}
