/**
 * Maintenance script: Close historical backlog without scoring.
 * Inserts DecisionJournal skip rows for all ObservedTrade rows older than the active baseline.
 * Idempotent, bounded batch execution.
 */
import { getDb, withDbRetry } from '../src/lib/db.ts';
import { num } from '../src/lib/env.ts';

export async function ensureActiveBaseline(db: any, reason = 'Paper trading baseline reset'): Promise<Date> {
  const existing = await db`SELECT "baselineAt" FROM "PaperBaseline" WHERE "active" = TRUE LIMIT 1`;
  if (existing.length > 0) {
    return new Date(existing[0].baselineAt);
  }
  const now = new Date();
  await db`
    INSERT INTO "PaperBaseline" ("baselineAt", "equityUsd", "reason", "active")
    VALUES (${now}, 10000, ${reason}, TRUE)
    ON CONFLICT ("active") WHERE "active" = TRUE DO NOTHING
  `;
  const active = await db`SELECT "baselineAt" FROM "PaperBaseline" WHERE "active" = TRUE LIMIT 1`;
  return new Date(active[0].baselineAt);
}

export async function closeBacklog(): Promise<{ totalClosed: number; batches: number }> {
  const initialDb = getDb();
  const baselineAt = await ensureActiveBaseline(initialDb);
  const batchSize = Math.max(1, Math.min(10000, num('TRADE_SCORE_BATCH_SIZE', 500)));

  // Fast start: find max observedTradeId already closed in DecisionJournal
  const maxClosedRow = await initialDb`SELECT COALESCE(MAX("observedTradeId"), 0) as max_id FROM "DecisionJournal"`;
  let lastClosedId = Number(maxClosedRow[0]?.max_id || 0);

  console.log(`Closing pre-baseline trade backlog (baselineAt: ${baselineAt.toISOString()}, startAfterId: ${lastClosedId}, batchSize: ${batchSize})...`);

  let totalClosed = 0;
  let batches = 0;

  while (true) {
    const res = await withDbRetry(async (db) => {
      const unscored = await db`
        SELECT ot."id", ot."walletAddress", ot."marketId", ot."isDemo"
        FROM "ObservedTrade" ot
        WHERE ot."id" > ${lastClosedId}
          AND COALESCE(ot."observedAt"::timestamp, ot."createdAt") < ${baselineAt}
        ORDER BY ot."id" ASC
        LIMIT ${batchSize}
      `;

      if (unscored.length === 0) return { count: 0, maxId: lastClosedId };

      const maxId = Number(unscored[unscored.length - 1].id);

      const count = await db.begin(async (tx: any) => {
        const rows = unscored.map((ot: any) => ({
          observedTradeId: ot.id,
          walletAddress: ot.walletAddress,
          marketId: ot.marketId,
          decision: 'skip',
          reasonsJson: '[]',
          risksJson: '["pre-baseline backlog"]',
          isDemo: ot.isDemo,
          evidenceStatus: 'PRE_BASELINE',
          decisionAt: new Date().toISOString(),
        }));

        await tx`
          INSERT INTO "DecisionJournal" ${tx(
            rows,
            'observedTradeId',
            'walletAddress',
            'marketId',
            'decision',
            'reasonsJson',
            'risksJson',
            'isDemo',
            'evidenceStatus',
            'decisionAt',
          )}
        `;
        return rows.length;
      });

      return { count, maxId };
    }, 'close-backlog-batch', 5);

    if (res.count === 0) break;

    lastClosedId = res.maxId;
    batches++;
    totalClosed += res.count;
    console.log(`Batch ${batches}: closed ${res.count} backlog trades (total: ${totalClosed}, lastId: ${lastClosedId})`);
  }

  console.log(`Backlog closure complete: closed ${totalClosed} trades across ${batches} batches.`);
  return { totalClosed, batches };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = getDb();
  try {
    const result = await closeBacklog();
    console.log(`Done. ${result.totalClosed} closed in ${result.batches} batches.`);
    process.exit(0);
  } catch (err) {
    console.error('Backlog closure failed:', err);
    process.exit(1);
  } finally {
    await db.end({ timeout: 5 });
  }
}
