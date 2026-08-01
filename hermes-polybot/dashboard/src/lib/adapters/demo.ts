// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Deterministic fixture-backed adapter — zero network, zero fabrication.
 * Fixtures live in runtime/fixtures/demo/. A missing or malformed fixture is an
 * AdapterError, never invented data. The clock is DEMO_NOW_ISO so replays are
 * reproducible: the same fixtures + the same clock always produce the same output. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optional } from '../env.ts';
import { AdapterError, type DataAdapter, type LeaderboardEntry, type MarketData, type WalletTrade } from './types.ts';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'demo');

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface DemoMarketTimelinePoint {
  atIso: string;
  yesPrice: number;
  bestBid: number;
  bestAsk: number;
  resolved?: boolean;
  resolvedOutcome?: string;
  umaResolutionStatus?: string;
}

interface DemoMarketFixture {
  marketId: string;
  conditionId: string;
  question: string;
  category?: string;
  slug?: string;
  liquidity: number;
  volume?: number;
  endDateIso: string;
  timeline: DemoMarketTimelinePoint[];
}

function loadJson(relPath: string): unknown {
  const full = join(FIXTURE_ROOT, relPath);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new AdapterError(`demo fixture missing: ${relPath}`);
  }
  try {
    return JSON.parse(text);
  } catch (e: any) {
    throw new AdapterError(`demo fixture malformed: ${relPath}: ${e.message}`);
  }
}

export function demoNow(): Date {
  const iso = optional('DEMO_NOW_ISO');
  if (iso === undefined) return new Date();
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw new AdapterError(`DEMO_NOW_ISO is not a valid ISO timestamp: ${iso}`);
  return parsed;
}

export class DemoAdapter implements DataAdapter {
  readonly source = 'demo';
  readonly isDemo = true;

  async fetchLeaderboard(limit = 500): Promise<LeaderboardEntry[]> {
    const rows = loadJson('leaderboard.json');
    if (!Array.isArray(rows)) throw new AdapterError('demo leaderboard.json must be an array');
    return rows.slice(0, limit).map((r: any, i: number) => {
      if (!r.address) throw new AdapterError(`demo leaderboard entry ${i} has no address`);
      return { address: String(r.address), label: r.label, rank: i + 1, pnl: Number(r.pnl ?? 0), volume: Number(r.volume ?? 0) };
    });
  }

  async fetchWalletTrades(address: string, sinceIso: string): Promise<WalletTrade[]> {
    if (!SAFE_ID.test(address)) throw new AdapterError(`demo wallet address contains unsafe characters: ${address}`);
    const sinceMs = new Date(sinceIso).getTime();
    if (Number.isNaN(sinceMs)) throw new AdapterError(`invalid sinceIso: ${sinceIso}`);
    const now = demoNow();
    const rows = loadJson(join('wallets', `${address}.json`));
    if (!Array.isArray(rows)) throw new AdapterError(`demo wallets/${address}.json must be an array`);
    return rows
      .filter((t: any) => {
        const ts = new Date(t.timestamp).getTime();
        if (Number.isNaN(ts)) throw new AdapterError(`demo trade for ${address} has invalid timestamp: ${t.timestamp}`);
        return ts >= sinceMs && ts <= now.getTime();
      })
      .map((t: any) => {
        const side = String(t.side ?? '').toUpperCase();
        if (side !== 'BUY' && side !== 'SELL') throw new AdapterError(`demo trade has unsupported side: ${t.side}`);
        const price = Number(t.price);
        const quantityShares = Number(t.quantityShares);
        const notionalUsd = Number(t.notionalUsd);
        if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new AdapterError('demo trade has invalid price');
        if (!Number.isFinite(quantityShares) || quantityShares <= 0) throw new AdapterError('demo trade has invalid share quantity');
        if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) throw new AdapterError('demo trade has invalid USDC notional');
        return {
          walletAddress: address,
          marketId: String(t.marketId),
          conditionId: t.conditionId,
          marketQuestion: t.marketQuestion,
          marketCategory: t.marketCategory,
          outcome: t.outcome,
          side: side as 'BUY' | 'SELL',
          price,
          size: notionalUsd,
          quantityShares,
          notionalUsd,
          providerEventId: t.providerEventId == null ? undefined : String(t.providerEventId),
          transactionHash: t.transactionHash == null ? undefined : String(t.transactionHash),
          assetId: t.assetId == null ? undefined : String(t.assetId),
          outcomeIndex: Number.isInteger(Number(t.outcomeIndex)) ? Number(t.outcomeIndex) : undefined,
          timestamp: new Date(t.timestamp).toISOString(),
          observedAt: now.toISOString(),
          raw: t,
        };
      });
  }

  async fetchMarket(marketId: string): Promise<MarketData> {
    if (!SAFE_ID.test(marketId)) throw new AdapterError(`demo marketId contains unsafe characters: ${marketId}`);
    const m = loadJson(join('markets', `${marketId}.json`)) as DemoMarketFixture;
    if (!Array.isArray(m.timeline) || m.timeline.length === 0) {
      throw new AdapterError(`demo market ${marketId} has no timeline`);
    }
    const now = demoNow();
    const eligible = m.timeline
      .map((p) => ({ point: p, atMs: new Date(p.atIso).getTime() }))
      .filter(({ point, atMs }) => {
        if (Number.isNaN(atMs)) throw new AdapterError(`demo market ${marketId} timeline has invalid atIso: ${point.atIso}`);
        return atMs <= now.getTime();
      })
      .sort((a, b) => a.atMs - b.atMs);
    if (eligible.length === 0) {
      throw new AdapterError(`demo market ${marketId} has no timeline point at or before ${now.toISOString()}`);
    }
    const p = eligible[eligible.length - 1].point;
    const yes = Number(p.yesPrice);
    const bid = Number(p.bestBid);
    const ask = Number(p.bestAsk);
    return {
      marketId: String(m.marketId ?? marketId),
      conditionId: m.conditionId,
      question: m.question,
      category: m.category,
      yesPrice: yes,
      noPrice: yes ? 1 - yes : undefined,
      bestBid: bid,
      bestAsk: ask,
      spread: ask && bid ? ask - bid : undefined,
      liquidity: Number(m.liquidity ?? 0),
      volume: Number(m.volume ?? 0),
      endDateIso: m.endDateIso,
      slug: m.slug,
      timeToResolutionHours: m.endDateIso ? (new Date(m.endDateIso).getTime() - now.getTime()) / 3.6e6 : undefined,
      resolved: Boolean(p.resolved),
      resolvedOutcome: p.resolvedOutcome,
      raw: { ...m, timeline: undefined, activePoint: p, umaResolutionStatus: p.umaResolutionStatus, resolvedOutcome: p.resolvedOutcome },
    };
  }

  async fetchPrice(marketId: string, outcome?: string): Promise<number> {
    const m = await this.fetchMarket(marketId);
    if (outcome?.toUpperCase() === 'NO') return m.noPrice ?? NaN;
    return m.yesPrice ?? NaN;
  }
}
