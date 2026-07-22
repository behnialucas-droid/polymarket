/** Batch profiler for 500 Polymarket wallets.
 * Processes 10 wallets concurrently for rapid 30-day historical analysis & Supabase storage. */
import { getDb } from '../src/lib/db.ts';
import { getAdapter, runLeaderboardScan, profileWallet } from './pipeline.ts';

const db = getDb();
const adapter = getAdapter();

async function main() {
  console.log(`[1/3] Ingesting Top 500 Leaderboard Wallets into Supabase...`);
  const count = await runLeaderboardScan(db, adapter, 500);
  console.log(`✓ ${count} Leaderboard Wallets written to Supabase.`);

  const wallets = await db`SELECT "address", "sourceRank" FROM "WalletProfile" ORDER BY "sourceRank" ASC NULLS LAST LIMIT 500`;
  console.log(`[2/3] Profiling ${wallets.length} wallets (30-day trade history & copyability algorithm)...`);

  const BATCH_SIZE = 10;
  let completed = 0;
  let errors = 0;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (w) => {
        try {
          await profileWallet(db, adapter, w.address);
          completed++;
        } catch (e: any) {
          errors++;
          console.warn(` [Rank ${w.sourceRank}] Profiling warning for ${w.address}: ${e?.message || e}`);
        }
      })
    );

    const percent = Math.round((completed / wallets.length) * 100);
    console.log(` Progress: ${completed}/${wallets.length} wallets profiled (${percent}%) [${errors} skipped/failed]`);
  }

  console.log(`\n[3/3] Wallet Status Distribution in Supabase:`);
  const statusCounts = await db`
    SELECT "status", COUNT(*) as count 
    FROM "WalletProfile" 
    GROUP BY "status"
  `;

  const scoredCount = await db`
    SELECT COUNT(*) as count 
    FROM "WalletProfile" 
    WHERE "globalScore" IS NOT NULL
  `;

  console.log(`======================================================`);
  console.log(`🎉 500-WALLET 30-DAY PROFILING COMPLETE`);
  console.log(` Total Scored Wallets: ${scoredCount[0].count}`);
  for (const row of statusCounts) {
    console.log(` • Status '${row.status}': ${row.count} wallets`);
  }
  console.log(`======================================================\n`);

  await db.end();
}

main().catch(async (err) => {
  console.error('Fatal profiling error:', err);
  await db.end();
  process.exit(1);
});
