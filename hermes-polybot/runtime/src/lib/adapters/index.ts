import { PolymarketAdapter } from './polymarket.ts';
import { DemoAdapter } from './demo.ts';
import type { DataAdapter } from './types.ts';

/** DATA_SOURCE selects the adapter. Unknown values fail loud — a silent
 * fallback to live data would misattribute demo intent to real markets. */
export function getAdapter(): DataAdapter {
  const source = (process.env.DATA_SOURCE ?? 'polymarket').toLowerCase();
  if (source === 'demo') return new DemoAdapter();
  if (source === 'polymarket' || source === 'live') return new PolymarketAdapter();
  throw new Error(`Unsupported DATA_SOURCE "${process.env.DATA_SOURCE}" — use "polymarket", "live", or "demo"`);
}

export * from './types.ts';
