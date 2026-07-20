import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/lib/db.ts';
import { getActiveRules, applyRuleChange, autoUpdateRules, DEFAULT_RULES } from '../src/lib/engine/rules.ts';

test('rule versioning: v1 auto-created, change bumps version with audit row', () => {
  const db = openMemoryDb();
  const v1 = getActiveRules(db);
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.rules, DEFAULT_RULES);

  const { newVersion } = applyRuleChange(db, {
    reason: 'test tighten spread',
    evidenceSummary: 'unit test',
    expectedImprovement: 'fewer spread losses',
    mutate: (r) => { r.maxSpread = 0.03; },
  });
  assert.equal(newVersion, 2);
  const active = getActiveRules(db);
  assert.equal(active.version, 2);
  assert.equal(active.rules.maxSpread, 0.03);
  // old version kept, inactive
  assert.equal((db.prepare('SELECT COUNT(*) n FROM RuleSet').get() as any).n, 2);
  assert.equal((db.prepare('SELECT active FROM RuleSet WHERE version = 1').get() as any).active, 0);
  const change = db.prepare('SELECT * FROM RuleChange').get() as any;
  assert.equal(change.changedBy, 'hermes');
  assert.equal(JSON.parse(change.beforeJson).maxSpread, DEFAULT_RULES.maxSpread);
  assert.equal(JSON.parse(change.afterJson).maxSpread, 0.03);
  assert.ok(change.reason.length > 0);
});

test('no-op mutation does not create a version', () => {
  const db = openMemoryDb();
  getActiveRules(db);
  const { newVersion } = applyRuleChange(db, { reason: 'noop', evidenceSummary: '', expectedImprovement: '', mutate: () => {} });
  assert.equal(newVersion, 1);
});

function seedResolvedTrades(db: any, n: number, pnl: number, scores: { spread?: number; liq?: number; timing?: number }) {
  for (let i = 0; i < n; i++) {
    const j = db.prepare('INSERT INTO DecisionJournal (walletAddress, marketId, decision, spreadScore, liquidityScore, entryTimingScore) VALUES (?,?,?,?,?,?)')
      .run('0xbad', `m${i}`, 'paper_copy', scores.spread ?? 0.9, scores.liq ?? 0.9, scores.timing ?? 0.9);
    db.prepare("INSERT INTO PaperTrade (decisionJournalId, walletAddress, marketId, entryPrice, simulatedPositionSize, status, realizedPnl) VALUES (?,?,?,0.5,10,'resolved',?)")
      .run(Number(j.lastInsertRowid), '0xbad', `m${i}`, pnl);
  }
}

test('automatic rule change: losing wide-spread trades tighten maxSpread with evidence', () => {
  const db = openMemoryDb();
  getActiveRules(db);
  seedResolvedTrades(db, 6, -5, { spread: 0.2 });
  const changes = autoUpdateRules(db);
  assert.ok(changes.length > 0);
  const active = getActiveRules(db);
  assert.ok(active.rules.maxSpread < DEFAULT_RULES.maxSpread);
  const change = db.prepare("SELECT * FROM RuleChange WHERE reason LIKE '%spread%'").get() as any;
  assert.ok(change, 'expected a spread rule change with audit trail');
  assert.ok(change.evidenceSummary.includes('resolved trades'));
});

test('automatic rule change: losing wallet downgraded to ignore', () => {
  const db = openMemoryDb();
  getActiveRules(db);
  db.prepare("INSERT INTO WalletProfile (address, status) VALUES ('0xbad','track')").run();
  seedResolvedTrades(db, 5, -8, {});
  autoUpdateRules(db);
  const w = db.prepare("SELECT status, statusReason FROM WalletProfile WHERE address = '0xbad'").get() as any;
  assert.equal(w.status, 'ignore');
  assert.match(w.statusReason, /Auto-downgrade/);
});

test('automatic rule change: insufficient evidence = no changes', () => {
  const db = openMemoryDb();
  getActiveRules(db);
  seedResolvedTrades(db, 2, -5, { spread: 0.2 });
  assert.equal(autoUpdateRules(db).length, 0);
});
