import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDecisionEvidence } from '../src/lib/engine/decisionEvidence.ts';
import { resetSignedPaperAccountEquity } from '../src/lib/engine/signedPaperLedgerDb.ts';

describe('baselineReset & short-term flow', () => {
  it('evaluates decision evidence: VALID with snapshot, MISSING_SNAPSHOT without snapshot', () => {
    const decisionAt = new Date('2026-08-01T12:00:00Z');

    // Valid snapshot captured 5 seconds prior
    const validEvidence = evaluateDecisionEvidence(
      {
        id: 101,
        marketId: 'mkt-1',
        quoteCollectedAt: '2026-08-01T11:59:55Z',
      },
      'mkt-1',
      decisionAt,
    );

    assert.equal(validEvidence.status, 'VALID');
    assert.equal(validEvidence.marketSnapshotId, 101);
    assert.equal(validEvidence.snapshotAgeMs, 5000);

    // Missing snapshot
    const missingEvidence = evaluateDecisionEvidence(null, 'mkt-1', decisionAt);
    assert.equal(missingEvidence.status, 'MISSING_SNAPSHOT');
    assert.equal(missingEvidence.marketSnapshotId, null);
    assert.equal(missingEvidence.reason, 'missing usable market snapshot at decision time');
  });

  it('resetSignedPaperAccountEquity refuses to run if open positions exist', async () => {
    const mockDb: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      const query = strings.join('?');
      if (query.includes('INSERT INTO "PaperAccount"')) {
        return [{ id: 42 }];
      }
      if (query.includes('FROM "SignedPaperPosition"') && query.includes('status')) {
        return [{ count: 1 }]; // 1 open position
      }
      if (query.includes('FROM "SignedPaperLot"')) {
        return [{ count: 0 }];
      }
      return [];
    };

    await assert.rejects(
      async () => {
        await resetSignedPaperAccountEquity(mockDb, true, 10000, 'Test reset');
      },
      (err: Error) => {
        assert.match(err.message, /Cannot perform equity reset: account has 1 open\/unsettled position/);
        return true;
      },
    );
  });

  it('resetSignedPaperAccountEquity succeeds on clean account', async () => {
    const executedQueries: string[] = [];
    const mockDb: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      const query = strings.join('?');
      executedQueries.push(query);
      if (query.includes('INSERT INTO "PaperAccount"')) {
        return [{ id: 42 }];
      }
      if (query.includes('FROM "SignedPaperPosition"') && query.includes('status')) {
        return [{ count: 0 }];
      }
      if (query.includes('FROM "SignedPaperLot"')) {
        return [{ count: 0 }];
      }
      if (query.includes('SELECT "startingCash" FROM "PaperAccount"')) {
        return [{ startingCash: 500.0 }];
      }
      return [];
    };

    const res = await resetSignedPaperAccountEquity(mockDb, true, 10000, 'Test reset clean');
    assert.equal(res.accountId, 42);
    assert.equal(res.priorStartingCash, 500);
    assert.equal(res.newStartingCash, 10000);

    assert.ok(executedQueries.some((q) => q.includes('UPDATE "PaperAccount"')));
    assert.ok(executedQueries.some((q) => q.includes('BASELINE_RESET')));
  });
});
