import { PolymarketAdapter } from './polymarket.ts';
import type { DataAdapter } from './types.ts';

export function getAdapter(): DataAdapter {
  return new PolymarketAdapter();
}

export * from './types.ts';
