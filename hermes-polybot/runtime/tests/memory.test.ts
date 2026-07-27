/**
 * Memory Renderer Tests — Foundation v2 Phase 5 Verification
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMemory, type RenderInput, type WalletRow } from '../src/lib/memory/render.ts';

const SAMPLE_WALLETS: WalletRow[] = Array.from({ length: 50 }, (_, i) => {
  const status: 'copy' | 'watch' | 'ignore' = i < 5 ? 'copy' : i < 20 ? 'watch' : 'ignore';
  return {
    address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    sourceRank: i + 1,
    memoryStatus: status,
    globalScore: 90.0 - i * 0.5,
    tradeCount30d: 20 + i,
    roi30d: 500.0 - i * 5,
    winRate30d: 0.75,
    consistencyScore: 0.80,
    maxDrawdown30d: 0.10,
    daysSinceLastTrade: 1,
    firstSeenGeneration: 1,
    memoryReason: `score ${(90.0 - i * 0.5).toFixed(1)}`,
  };
});

const INPUT: RenderInput = {
  generation: 1,
  status: 'complete',
  completedAt: '2026-08-01T00:00:00.000Z',
  nextDueAt: '2026-08-31T00:00:00.000Z',
  ruleSetVersion: 'v1',
  windowDays: 30,
  failedAddresses: [],
  wallets: SAMPLE_WALLETS,
};

test('renderMemory — INDEX.md is at most 150 lines', () => {
  const files = renderMemory(INPUT);
  const indexFile = files.find((f) => f.path === 'memory/INDEX.md');
  assert.ok(indexFile, 'INDEX.md should exist');

  const lineCount = indexFile.content.split('\n').length;
  assert.ok(lineCount <= 150, `INDEX.md line count ${lineCount} exceeds 150 limit`);
});

test('renderMemory — deterministic output across two independent runs', () => {
  const run1 = renderMemory(INPUT);
  const run2 = renderMemory(INPUT);

  assert.equal(run1.length, run2.length);
  for (let i = 0; i < run1.length; i++) {
    assert.equal(run1[i].path, run2[i].path);
    assert.equal(run1[i].content, run2[i].content);
  }
});

test('renderMemory — zero timestamps in roster.csv or wallets/', () => {
  const files = renderMemory(INPUT);
  const isoPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

  for (const f of files) {
    if (f.path.startsWith('memory/roster.csv') || f.path.startsWith('memory/wallets/')) {
      assert.ok(
        !isoPattern.test(f.content),
        `Timestamp leaked into ${f.path}`
      );
    }
  }
});

test('renderMemory — ignore-tier wallets get roster row but NO detail file', () => {
  const files = renderMemory(INPUT);
  const ignoreFiles = files.filter((f) => f.path.startsWith('memory/wallets/ignore/'));
  assert.equal(ignoreFiles.length, 0, 'ignore-tier wallets must not have detail files');

  const copyFiles = files.filter((f) => f.path.startsWith('memory/wallets/copy/'));
  assert.equal(copyFiles.length, 5, 'copy-tier wallets should have 5 detail files');

  const watchFiles = files.filter((f) => f.path.startsWith('memory/wallets/watch/'));
  assert.equal(watchFiles.length, 15, 'watch-tier wallets should have 15 detail files');
});
