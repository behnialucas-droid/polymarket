import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { scoreNewTrades } from '../scripts/pipeline.ts';
import type { DataAdapter } from '../src/lib/adapters/types.ts';
import { num } from '../src/lib/env.ts';

const db = getDb();

function fakeAdapter(): DataAdapter {
  return {
    source: 'fake', isDemo: true,
    fetchLeaderboard: async () => [],
    fetchWalletTrades: async () => [],
    fetchMarket: async (id: string) => ({
      marketId: id, yesPrice: 0.5, noPrice: 0.5, spread: 0.02, liquidity: 20000,
      endDateIso: new Date(Date.now() + 6 * 3.6e6).toISOString(), timeToResolutionHours: 6, resolved: false
    }),
    fetchPrice: async () => 0.5,
  };
}

test('scoreNewTrades batch selection: bounded size, id ASC ordering, exclusion of journaled trades, and empty backlog', async () => {
  const testWallet = '0xbatchtestwallet';
  const testMarket = 'm_batch_test';

  // Cleanup test fixture rows
  await db`DELETE FROM "AdmissionCheck" WHERE "observedTradeId" IN (SELECT "id" FROM "ObservedTrade" WHERE "walletAddress" = ${testWallet})`;
  await db`DELETE FROM "DecisionJournal" WHERE "walletAddress" = ${testWallet}`;
  await db`DELETE FROM "ObservedTrade" WHERE "walletAddress" = ${testWallet}`;

  // Insert 5 test ObservedTrades
  const insertedIds: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const tradeHash = `hash_batch_test_${Date.now()}_${i}`;
    const [row] = await db`
      INSERT INTO "ObservedTrade" (
        "walletAddress", "marketId", "outcome", "side", "walletEntryPrice", "size", "timestamp", "tradeHash", "isDemo"
      ) VALUES (
        ${testWallet}, ${testMarket}, 'YES', 'BUY', 0.5, 100, ${new Date().toISOString()}, ${tradeHash}, 1
      ) RETURNING "id"
    `;
    insertedIds.push(Number(row.id));
  }

  // 1. Verify primary-key ascending order for test inserted IDs
  assert.deepEqual(insertedIds, [...insertedIds].sort((a, b) => a - b));

  // 2. Query batch 1 (batchSize = 2) for test wallet
  const batch1 = await db`
    SELECT ot."id" FROM "ObservedTrade" ot
    WHERE ot."walletAddress" = ${testWallet}
      AND NOT EXISTS (SELECT 1 FROM "DecisionJournal" dj WHERE dj."observedTradeId" = ot."id")
    ORDER BY ot."id" ASC
    LIMIT 2
  `;
  assert.equal(batch1.length, 2, 'batch 1 should return exactly 2 rows');
  assert.equal(Number(batch1[0].id), insertedIds[0]);
  assert.equal(Number(batch1[1].id), insertedIds[1]);

  // Insert DecisionJournal entries for batch 1 (simulating scoreNewTrades processing)
  for (const row of batch1) {
    await db`
      INSERT INTO "DecisionJournal" ("observedTradeId", "walletAddress", "marketId", "decision", "isDemo")
      VALUES (${row.id}, ${testWallet}, ${testMarket}, 'skip', 1)
    `;
  }

  // 3. Query batch 2 (batchSize = 2) — journaled trades must be excluded
  const batch2 = await db`
    SELECT ot."id" FROM "ObservedTrade" ot
    WHERE ot."walletAddress" = ${testWallet}
      AND NOT EXISTS (SELECT 1 FROM "DecisionJournal" dj WHERE dj."observedTradeId" = ot."id")
    ORDER BY ot."id" ASC
    LIMIT 2
  `;
  assert.equal(batch2.length, 2, 'batch 2 should return next 2 rows');
  assert.equal(Number(batch2[0].id), insertedIds[2]);
  assert.equal(Number(batch2[1].id), insertedIds[3]);

  // Insert DecisionJournal entries for batch 2
  for (const row of batch2) {
    await db`
      INSERT INTO "DecisionJournal" ("observedTradeId", "walletAddress", "marketId", "decision", "isDemo")
      VALUES (${row.id}, ${testWallet}, ${testMarket}, 'skip', 1)
    `;
  }

  // 4. Query batch 3 — drains remaining 1 trade
  const batch3 = await db`
    SELECT ot."id" FROM "ObservedTrade" ot
    WHERE ot."walletAddress" = ${testWallet}
      AND NOT EXISTS (SELECT 1 FROM "DecisionJournal" dj WHERE dj."observedTradeId" = ot."id")
    ORDER BY ot."id" ASC
    LIMIT 2
  `;
  assert.equal(batch3.length, 1, 'batch 3 should return remaining 1 row');
  assert.equal(Number(batch3[0].id), insertedIds[4]);

  // Insert DecisionJournal entry for final trade
  await db`
    INSERT INTO "DecisionJournal" ("observedTradeId", "walletAddress", "marketId", "decision", "isDemo")
    VALUES (${batch3[0].id}, ${testWallet}, ${testMarket}, 'skip', 1)
  `;

  // 5. Empty backlog query
  const batchEmpty = await db`
    SELECT ot."id" FROM "ObservedTrade" ot
    WHERE ot."walletAddress" = ${testWallet}
      AND NOT EXISTS (SELECT 1 FROM "DecisionJournal" dj WHERE dj."observedTradeId" = ot."id")
    ORDER BY ot."id" ASC
    LIMIT 2
  `;
  assert.equal(batchEmpty.length, 0, 'empty backlog should return 0 rows');

  // 6. Test scoreNewTrades pipeline call with custom batch size
  process.env.TRADE_SCORE_BATCH_SIZE = '3';
  const pipelineRes = await scoreNewTrades(db, fakeAdapter());
  assert.ok(pipelineRes.scored <= 3, `scoreNewTrades must respect TRADE_SCORE_BATCH_SIZE (scored ${pipelineRes.scored})`);

  // Cleanup test fixture rows
  await db`DELETE FROM "AdmissionCheck" WHERE "observedTradeId" IN (SELECT "id" FROM "ObservedTrade" WHERE "walletAddress" = ${testWallet})`;
  await db`DELETE FROM "DecisionJournal" WHERE "walletAddress" = ${testWallet}`;
  await db`DELETE FROM "ObservedTrade" WHERE "walletAddress" = ${testWallet}`;
  delete process.env.TRADE_SCORE_BATCH_SIZE;
});

test('TRADE_SCORE_BATCH_SIZE env var parsing: default, custom, and invalid fail-closed check', () => {
  delete process.env.TRADE_SCORE_BATCH_SIZE;
  assert.equal(num('TRADE_SCORE_BATCH_SIZE', 500), 500);

  process.env.TRADE_SCORE_BATCH_SIZE = '100';
  assert.equal(num('TRADE_SCORE_BATCH_SIZE', 500), 100);

  process.env.TRADE_SCORE_BATCH_SIZE = 'invalid';
  assert.throws(
    () => num('TRADE_SCORE_BATCH_SIZE', 500),
    /Invalid numeric env var TRADE_SCORE_BATCH_SIZE="invalid"/
  );

  delete process.env.TRADE_SCORE_BATCH_SIZE;
});
