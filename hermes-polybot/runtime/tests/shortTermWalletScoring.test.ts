import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scoreShortTermWallet,
  selectTopWallets,
  isConfirmedShortTermResolved,
  DEFAULT_SHORT_TERM_SCORE_CONFIG,
} from '../src/lib/engine/shortTermWalletScoring.ts';
import type { TradeWithMarket } from '../src/lib/engine/walletScoring.ts';

const T0 = Date.parse('2026-08-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function item(opts: {
  entryMsBeforeEnd: number;
  endMsBeforeScoring: number;
  won: boolean;
  price?: number;
  size?: number;
  resolved?: boolean;
  outcome?: string;
}): TradeWithMarket {
  const endMs = T0 - opts.endMsBeforeScoring;
  const entryMs = endMs - opts.entryMsBeforeEnd;
  const price = opts.price ?? 0.5;
  const resolved = opts.resolved ?? true;
  return {
    trade: {
      walletAddress: '0xw', marketId: 'm', outcome: 'YES', side: 'BUY',
      price, size: opts.size ?? 10, notionalUsd: opts.size ?? 10,
      timestamp: iso(entryMs),
    },
    market: {
      marketId: 'm',
      endDateIso: iso(endMs),
      resolved,
      resolvedOutcome: resolved ? (opts.outcome ?? (opts.won ? 'YES' : 'NO')) : undefined,
    },
    pnlPerDollar: resolved ? ((opts.won ? 1 : 0) - price) / price : undefined,
  };
}

const H = 3.6e6;
const D = 864e5;

test('short-term filter: 23h commitment counts, 25h commitment is excluded', () => {
  const inside = item({ entryMsBeforeEnd: 23 * H, endMsBeforeScoring: 1 * D, won: true });
  const outside = item({ entryMsBeforeEnd: 25 * H, endMsBeforeScoring: 1 * D, won: true });
  assert.equal(isConfirmedShortTermResolved(inside, T0, 24), true);
  assert.equal(isConfirmedShortTermResolved(outside, T0, 24), false);
});

test('no-lookahead: a market ending after scoring time never counts, resolved or not', () => {
  const future = item({ entryMsBeforeEnd: 5 * H, endMsBeforeScoring: -2 * H, won: true });
  assert.equal(isConfirmedShortTermResolved(future, T0, 24), false);
  const unresolved = item({ entryMsBeforeEnd: 5 * H, endMsBeforeScoring: 1 * D, won: true, resolved: false });
  assert.equal(isConfirmedShortTermResolved(unresolved, T0, 24), false);
});

test('minimum sample fails closed: below minTrades the copy score is null, never a default pass', () => {
  const items = Array.from({ length: 9 }, () => item({ entryMsBeforeEnd: 5 * H, endMsBeforeScoring: 1 * D, won: true }));
  const s = scoreShortTermWallet(items, T0, DEFAULT_SHORT_TERM_SCORE_CONFIG);
  assert.equal(s.valid, false);
  assert.equal(s.shortTermCopyScore, null);
  assert.equal(s.shortTermTradeCount, 9);
});

test('at minimum sample the score becomes valid and bounded 0..1', () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    item({ entryMsBeforeEnd: 5 * H, endMsBeforeScoring: (i + 1) * D, won: i % 2 === 0 }));
  const s = scoreShortTermWallet(items, T0, DEFAULT_SHORT_TERM_SCORE_CONFIG);
  assert.equal(s.valid, true);
  assert.ok(s.shortTermCopyScore !== null && s.shortTermCopyScore >= 0 && s.shortTermCopyScore <= 1);
  assert.ok(s.shortTermWinRate > 0 && s.shortTermWinRate < 1);
});

test('recency decay: identical records score higher when recent than when old', () => {
  const recent = Array.from({ length: 10 }, () => item({ entryMsBeforeEnd: 5 * H, endMsBeforeScoring: 1 * D, won: true }));
  const old = Array.from({ length: 10 }, () => item({ entryMsBeforeEnd: 5 * H, endMsBeforeScoring: 28 * D, won: true }));
  const sRecent = scoreShortTermWallet(recent, T0, DEFAULT_SHORT_TERM_SCORE_CONFIG);
  const sOld = scoreShortTermWallet(old, T0, DEFAULT_SHORT_TERM_SCORE_CONFIG);
  assert.ok(sRecent.shortTermCopyScore! > sOld.shortTermCopyScore!);
  assert.ok(sRecent.shortTermRecencyWeight > sOld.shortTermRecencyWeight);
});

test('losses lower the score versus wins on the same sample', () => {
  const wins = Array.from({ length: 10 }, () => item({ entryMsBeforeEnd: 5 * H, endMsBeforeScoring: 1 * D, won: true }));
  const losses = Array.from({ length: 10 }, () => item({ entryMsBeforeEnd: 5 * H, endMsBeforeScoring: 1 * D, won: false }));
  const sW = scoreShortTermWallet(wins, T0, DEFAULT_SHORT_TERM_SCORE_CONFIG);
  const sL = scoreShortTermWallet(losses, T0, DEFAULT_SHORT_TERM_SCORE_CONFIG);
  assert.ok(sW.shortTermCopyScore! > sL.shortTermCopyScore!);
  assert.equal(sL.shortTermWinRate, 0);
});

test('long-term history alone can never qualify a wallet', () => {
  const longTerm = Array.from({ length: 50 }, () => item({ entryMsBeforeEnd: 30 * 24 * H, endMsBeforeScoring: 1 * D, won: true }));
  const s = scoreShortTermWallet(longTerm, T0, DEFAULT_SHORT_TERM_SCORE_CONFIG);
  assert.equal(s.valid, false);
  assert.equal(s.shortTermCopyScore, null);
});

test('top-N selection is deterministic with address tie-break and hard truncation', () => {
  const candidates = [
    { address: '0xccc', shortTermCopyScore: 0.8 },
    { address: '0xaaa', shortTermCopyScore: 0.8 },
    { address: '0xbbb', shortTermCopyScore: 0.9 },
    { address: '0xddd', shortTermCopyScore: 0.7 },
  ];
  const top = selectTopWallets(candidates, 3);
  assert.deepEqual(top.map((t) => t.address), ['0xbbb', '0xaaa', '0xccc']);
  const again = selectTopWallets([...candidates].reverse(), 3);
  assert.deepEqual(again.map((t) => t.address), ['0xbbb', '0xaaa', '0xccc']);
});
