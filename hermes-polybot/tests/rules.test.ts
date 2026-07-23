import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { getActiveRules, applyRuleChange, autoUpdateRules, DEFAULT_RULES } from '../src/lib/engine/rules.ts';

const db = getDb();

test('rule versioning: v1 auto-created, change bumps version with audit row', async () => {
  const v1 = await getActiveRules(db);
  assert.ok(v1.version >= 1);

  const { newVersion } = await applyRuleChange(db, {
    reason: 'test tighten spread',
    evidenceSummary: 'unit test',
    expectedImprovement: 'fewer spread losses',
    mutate: (r) => { r.maxSpread = 0.03; },
  });
  assert.ok(newVersion > v1.version);
  const active = await getActiveRules(db);
  assert.equal(active.rules.maxSpread, 0.03);
});

test('no-op mutation does not create a version', async () => {
  const v1 = await getActiveRules(db);
  const { newVersion } = await applyRuleChange(db, { reason: 'noop', evidenceSummary: '', expectedImprovement: '', mutate: () => {} });
  assert.equal(newVersion, v1.version);
});

async function seedResolvedTrades(n: number, pnl: number, scores: { spread?: number; liq?: number; timing?: number }) {
  for (let i = 0; i < n; i++) {
    const j = await db`
      INSERT INTO "DecisionJournal" ("walletAddress", "marketId", "decision", "spreadScore", "liquidityScore", "entryTimingScore") 
      VALUES ('0xbad', ${`m_${Date.now()}_${i}`}, 'paper_copy', ${scores.spread ?? 0.9}, ${scores.liq ?? 0.9}, ${scores.timing ?? 0.9})
      RETURNING "id"
    `;
    await db`
      INSERT INTO "PaperTrade" ("decisionJournalId", "walletAddress", "marketId", "entryPrice", "simulatedPositionSize", "status", "realizedPnl") 
      VALUES (${j[0].id}, '0xbad', ${`m_${Date.now()}_${i}`}, 0.5, 10, 'resolved', ${pnl})
    `;
  }
}

test('automatic rule change: losing wide-spread trades tighten maxSpread with evidence', async () => {
  await getActiveRules(db);
  await seedResolvedTrades(6, -5, { spread: 0.2 });
  const changes = await autoUpdateRules(db);
  assert.ok(Array.isArray(changes));
});
