/**
 * Activate a candidate ScoringEpoch as THE copy-gating wallet universe.
 *
 * Dry-run by default: prints a diff summary (ranked counts, score percentiles,
 * added/removed wallet counts vs the currently active epoch). Requires
 * EPOCH_CONFIRM=yes to actually flip the active pointer; the switch and its
 * audit row commit in one transaction. Idempotent: re-activating the already
 * active epoch is a no-op.
 */
import { getDb } from '../src/lib/db.ts';

const db = getDb();
const epochId = Number(process.env.EPOCH_ID ?? NaN);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

try {
  if (!Number.isInteger(epochId) || epochId <= 0) {
    console.error('EPOCH_ID env var is required (integer id from rescore-wallets-shortterm.ts output)');
    process.exit(1);
  }
  const candidates = await db`SELECT * FROM "ScoringEpoch" WHERE "id" = ${epochId}`;
  if (candidates.length === 0) {
    console.error(`ScoringEpoch ${epochId} does not exist`);
    process.exit(1);
  }
  const actives = await db`SELECT "id" FROM "ScoringEpoch" WHERE "active" = TRUE`;
  const fromEpochId = actives[0]?.id != null ? Number(actives[0].id) : null;

  const newRanked = await db`
    SELECT "address", "shortTermCopyScore" FROM "WalletProfile"
    WHERE "scoringEpoch" = ${epochId} AND "shortTermRank" IS NOT NULL
  `;
  const oldRanked = fromEpochId == null ? [] : await db`
    SELECT "address" FROM "WalletProfile"
    WHERE "scoringEpoch" = ${fromEpochId} AND "shortTermRank" IS NOT NULL
  `;
  const oldSet = new Set(oldRanked.map((r: any) => r.address));
  const newSet = new Set(newRanked.map((r: any) => r.address));
  const added = [...newSet].filter((a) => !oldSet.has(a)).length;
  const removed = [...oldSet].filter((a) => !newSet.has(a)).length;
  const scores = newRanked.map((r: any) => Number(r.shortTermCopyScore)).sort((a, b) => a - b);

  const summary = {
    fromEpochId,
    toEpochId: epochId,
    trackedBefore: oldRanked.length,
    trackedAfter: newRanked.length,
    walletsAdded: added,
    walletsRemoved: removed,
    scoreP10: percentile(scores, 10),
    scoreP50: percentile(scores, 50),
    scoreP90: percentile(scores, 90),
  };
  console.log('epoch activation diff:', JSON.stringify(summary, null, 2));

  if (fromEpochId === epochId) {
    console.log(`epoch ${epochId} is already active — nothing to do`);
    process.exit(0);
  }
  if (newRanked.length === 0) {
    console.error('refusing to activate an epoch with zero ranked wallets (empty copy universe)');
    process.exit(1);
  }
  if (process.env.EPOCH_CONFIRM !== 'yes') {
    console.log('dry run only. Re-run with EPOCH_CONFIRM=yes to activate.');
    process.exit(0);
  }

  await db.begin(async (tx) => {
    await tx`UPDATE "ScoringEpoch" SET "active" = FALSE WHERE "active" = TRUE`;
    await tx`UPDATE "ScoringEpoch" SET "active" = TRUE, "activatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${epochId}`;
    await tx`
      INSERT INTO "ScoringEpochAudit" ("fromEpochId", "toEpochId", "trackedBefore", "trackedAfter", "summaryJson")
      VALUES (${fromEpochId}, ${epochId}, ${oldRanked.length}, ${newRanked.length}, ${JSON.stringify(summary)})
    `;
  });
  console.log(`ScoringEpoch ${epochId} is now ACTIVE. Pipeline copy gate now requires this epoch.`);
} finally {
  await db.end({ timeout: 5 }).catch(() => {});
}
