import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DemoAdapter } from '../src/lib/adapters/demo.ts';
import { getAdapter } from '../src/lib/adapters/index.ts';
import { AdapterError } from '../src/lib/adapters/types.ts';

const CLOCK = '2026-08-01T00:00:00.000Z';
let savedNow: string | undefined;
let savedSource: string | undefined;

beforeEach(() => {
  savedNow = process.env.DEMO_NOW_ISO;
  savedSource = process.env.DATA_SOURCE;
  process.env.DEMO_NOW_ISO = CLOCK;
});
afterEach(() => {
  if (savedNow === undefined) delete process.env.DEMO_NOW_ISO; else process.env.DEMO_NOW_ISO = savedNow;
  if (savedSource === undefined) delete process.env.DATA_SOURCE; else process.env.DATA_SOURCE = savedSource;
});

test('getAdapter selects demo, live, and fails loud on unknown sources', () => {
  process.env.DATA_SOURCE = 'demo';
  assert.equal(getAdapter().source, 'demo');
  assert.equal(getAdapter().isDemo, true);
  process.env.DATA_SOURCE = 'live';
  assert.equal(getAdapter().source, 'polymarket');
  delete process.env.DATA_SOURCE;
  assert.equal(getAdapter().source, 'polymarket');
  process.env.DATA_SOURCE = 'garbage';
  assert.throws(() => getAdapter(), /Unsupported DATA_SOURCE/);
});

test('demo adapter is deterministic across constructions', async () => {
  const a = new DemoAdapter();
  const b = new DemoAdapter();
  assert.deepEqual(await a.fetchLeaderboard(10), await b.fetchLeaderboard(10));
  assert.deepEqual(
    await a.fetchWalletTrades('0xdemowalletalpha', '2026-07-01T00:00:00.000Z'),
    await b.fetchWalletTrades('0xdemowalletalpha', '2026-07-01T00:00:00.000Z'),
  );
  assert.deepEqual(await a.fetchMarket('demo-btc-up-aug1'), await b.fetchMarket('demo-btc-up-aug1'));
});

test('wallet trades filter by sinceIso and never come from the clock future', async () => {
  const adapter = new DemoAdapter();
  const all = await adapter.fetchWalletTrades('0xdemowalletalpha', '2026-07-01T00:00:00.000Z');
  assert.equal(all.length, 14); // 12 history + 2 fresh signals
  const fresh = await adapter.fetchWalletTrades('0xdemowalletalpha', '2026-07-31T00:00:00.000Z');
  assert.equal(fresh.length, 2);
  assert.ok(fresh.some((t) => t.side === 'SELL'), 'fixture must include a source SELL');
  for (const t of all) assert.ok(new Date(t.timestamp).getTime() <= new Date(CLOCK).getTime());
});

test('market timeline selects the latest point at or before the demo clock', async () => {
  const adapter = new DemoAdapter();
  const before = await adapter.fetchMarket('demo-btc-up-aug1');
  assert.equal(before.yesPrice, 0.55);
  assert.equal(before.resolved, false);

  process.env.DEMO_NOW_ISO = '2026-08-02T00:00:00.000Z';
  const after = await adapter.fetchMarket('demo-btc-up-aug1');
  assert.equal(after.resolved, true);
  assert.equal(after.resolvedOutcome, 'Yes');
  assert.equal((after.raw as any).umaResolutionStatus, 'resolved');

  const unresolved = await adapter.fetchMarket('demo-sol-up-aug2');
  assert.equal(unresolved.resolved, false);
  assert.equal(unresolved.resolvedOutcome, undefined);
});

test('demo adapter fails loud instead of fabricating', async () => {
  const adapter = new DemoAdapter();
  await assert.rejects(() => adapter.fetchMarket('no-such-market'), AdapterError);
  await assert.rejects(() => adapter.fetchMarket('../escape'), AdapterError);
  await assert.rejects(() => adapter.fetchWalletTrades('../etc', '2026-07-01T00:00:00.000Z'), AdapterError);
  process.env.DEMO_NOW_ISO = '2026-07-01T00:00:00.000Z';
  await assert.rejects(() => adapter.fetchMarket('demo-btc-up-aug1'), /no timeline point/);
  process.env.DEMO_NOW_ISO = 'not-a-date';
  await assert.rejects(() => adapter.fetchMarket('demo-btc-up-aug1'), /DEMO_NOW_ISO/);
});

test('demo fetchPrice follows outcome side', async () => {
  const adapter = new DemoAdapter();
  assert.equal(await adapter.fetchPrice('demo-doge-up-aug1', 'YES'), 0.7);
  assert.ok(Math.abs((await adapter.fetchPrice('demo-doge-up-aug1', 'NO')) - 0.3) < 1e-12);
});
