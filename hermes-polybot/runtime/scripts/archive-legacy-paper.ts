/**
 * Maintenance script: Archive legacy paper trades and PnL snapshots out of active reporting.
 * Copies PaperTrade and PnlSnapshot rows into PaperTradeArchive and PnlSnapshotArchive,
 * then deletes them from active tables in atomic transactions per batch.
 *
 * Safety:
 *  - Must print dry-run summary (counts only) first.
 *  - Requires environment variable ARCHIVE_CONFIRM=yes to execute actual archival.
 */
import { getDb } from '../src/lib/db.ts';
import { num } from '../src/lib/env.ts';

export async function getArchiveCounts(db: any): Promise<{ paperTradeCount: number; pnlSnapshotCount: number }> {
  const [tradeCount] = await db`SELECT COUNT(*)::int AS count FROM "PaperTrade"`;
  const [snapshotCount] = await db`SELECT COUNT(*)::int AS count FROM "PnlSnapshot"`;
  return {
    paperTradeCount: Number(tradeCount.count),
    pnlSnapshotCount: Number(snapshotCount.count),
  };
}

export async function archiveLegacyPaper(confirm = false, reason = 'Legacy PnL baseline archival'): Promise<{
  archivedTrades: number;
  archivedSnapshots: number;
  dryRun: boolean;
}> {
  const db = getDb();
  const counts = await getArchiveCounts(db);

  console.log(`Archival Dry-Run Summary:`);
  console.log(`  - Legacy PaperTrade rows pending archive: ${counts.paperTradeCount}`);
  console.log(`  - Legacy PnlSnapshot rows pending archive: ${counts.pnlSnapshotCount}`);

  if (!confirm) {
    console.log(`\n[DRY RUN ONLY] ARCHIVE_CONFIRM is not set to "yes". No rows were modified.`);
    console.log(`To execute archival, set ARCHIVE_CONFIRM=yes and run again.`);
    return {
      archivedTrades: counts.paperTradeCount,
      archivedSnapshots: counts.pnlSnapshotCount,
      dryRun: true,
    };
  }

  if (counts.paperTradeCount === 0 && counts.pnlSnapshotCount === 0) {
    console.log(`\nNo legacy paper trade or snapshot rows to archive.`);
    return { archivedTrades: 0, archivedSnapshots: 0, dryRun: false };
  }

  console.log(`\nExecuting archival with ARCHIVE_CONFIRM=yes...`);

  const batchSize = Math.max(1, Math.min(10000, num('TRADE_SCORE_BATCH_SIZE', 500)));
  let totalTradesArchived = 0;
  let totalSnapshotsArchived = 0;

  // 1. Archive PnlSnapshots in batches
  while (true) {
    const snapshotsToArchive = await db`
      SELECT * FROM "PnlSnapshot"
      ORDER BY "id" ASC
      LIMIT ${batchSize}
    `;
    if (snapshotsToArchive.length === 0) break;

    const archivedCount = await db.begin(async (tx: any) => {
      const ids = snapshotsToArchive.map((s: any) => s.id);
      await tx`
        INSERT INTO "PnlSnapshotArchive" (
          "id", "paperTradeId", "price", "pnl", "collectedAt", "archiveReason"
        )
        SELECT "id", "paperTradeId", "price", "pnl", "collectedAt", ${reason}
        FROM "PnlSnapshot"
        WHERE "id" = ANY(${ids})
        ON CONFLICT ("id") DO NOTHING
      `;

      await tx`
        DELETE FROM "PnlSnapshot"
        WHERE "id" = ANY(${ids})
      `;
      return ids.length;
    });

    totalSnapshotsArchived += archivedCount;
    console.log(`Archived batch: ${archivedCount} PnlSnapshot rows (total: ${totalSnapshotsArchived})`);
  }

  // 2. Archive PaperTrades in batches
  while (true) {
    const tradesToArchive = await db`
      SELECT * FROM "PaperTrade"
      ORDER BY "id" ASC
      LIMIT ${batchSize}
    `;
    if (tradesToArchive.length === 0) break;

    const archivedCount = await db.begin(async (tx: any) => {
      const ids = tradesToArchive.map((t: any) => t.id);
      await tx`
        INSERT INTO "PaperTradeArchive" (
          "id", "decisionJournalId", "walletAddress", "marketId", "outcome", "side",
          "entryPrice", "currentPrice", "simulatedPositionSize", "unrealizedPnl",
          "realizedPnl", "status", "reason", "isDemo", "openedAt", "closedAt",
          "resolvedAt", "archiveReason"
        )
        SELECT "id", "decisionJournalId", "walletAddress", "marketId", "outcome", "side",
               "entryPrice", "currentPrice", "simulatedPositionSize", "unrealizedPnl",
               "realizedPnl", "status", "reason", "isDemo", "openedAt", "closedAt",
               "resolvedAt", ${reason}
        FROM "PaperTrade"
        WHERE "id" = ANY(${ids})
        ON CONFLICT ("id") DO NOTHING
      `;

      await tx`
        UPDATE "OutcomeReview"
        SET "paperTradeId" = NULL
        WHERE "paperTradeId" = ANY(${ids})
      `;

      await tx`
        DELETE FROM "PaperTrade"
        WHERE "id" = ANY(${ids})
      `;
      return ids.length;
    });

    totalTradesArchived += archivedCount;
    console.log(`Archived batch: ${archivedCount} PaperTrade rows (total: ${totalTradesArchived})`);
  }

  console.log(`\nArchival complete! ${totalTradesArchived} trades and ${totalSnapshotsArchived} snapshots archived.`);
  return {
    archivedTrades: totalTradesArchived,
    archivedSnapshots: totalSnapshotsArchived,
    dryRun: false,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = getDb();
  const isConfirmed = process.env.ARCHIVE_CONFIRM?.toLowerCase() === 'yes';
  try {
    const res = await archiveLegacyPaper(isConfirmed);
    if (res.dryRun) {
      console.log(`To execute actual archival, re-run with ARCHIVE_CONFIRM=yes`);
    } else {
      console.log(`Successfully archived ${res.archivedTrades} trades and ${res.archivedSnapshots} snapshots.`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Archival failed:', err);
    process.exit(1);
  } finally {
    await db.end({ timeout: 5 });
  }
}
