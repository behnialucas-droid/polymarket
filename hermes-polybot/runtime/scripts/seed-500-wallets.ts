/** Master script: Ingests 500 Polymarket leaderboard wallets, fetches past 30-day trade history,
 * runs the copyability algorithm, and stores complete profile metrics in Supabase. */
import { getDb } from '../src/lib/db.ts';
import { getAdapter, runLeaderboardScan, profileWallet } from './pipeline.ts';

const db = getDb();
const adapter = getAdapter();

async function main() {
  console.log(`[1/3] Starting 500-Wallet Leaderboard Ingestion (${adapter.source})...`);
  const leaderboardCount = await runLeaderboardScan(db, adapter, 500);
  console.log(`✓ Successfully ingested ${leaderboardCount} wallets into Supabase LeaderboardScan & WalletProfile tables.`);

  const wallets = await db`SELECT "address", "sourceRank" FROM "WalletProfile" ORDER BY "sourceRank" ASC NULLS LAST LIMIT 500`;
  console.log(`[2/3] Profiling ${wallets.length} wallets (30-day trade history & copyability algorithm)...`);

  let scanned = 0;
  let failed = 0;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    try {
      await profileWallet(db, adapter, w.address);
      scanned++;
    } catch (err: any) {
      failed++;
      console.warn(` Warning: Profiling skipped for rank ${w.sourceRank} (${w.address}): ${err?.message || err}`);
    }

    if ((i + 1) % 10 === 0 || i === wallets.length - 1) {
      console.log(`  Progress: ${i + 1}/${wallets.length} wallets processed (${scanned} ok, ${failed} warnings)...`);
    }
  }

  console.log(`[3/3] Generating Summary Analytics...`);
  const statusCounts = await db`
    SELECT "status", COUNT(*) as n 
    FROM "WalletProfile" 
    GROUP BY "status"
  `;

  console.log(`\n======================================================`);
  console.log(`🎉 SUPABASE WALLET INDEXING & COPYABILITY ANALYSIS COMPLETE`);
  console.log(`======================================================`);
  for (const row of statusCounts) {
    console.log(` • Status '${row.status}': ${row.n} wallets`);
  }
  console.log(`======================================================\n`);

  await db.end();
}

main().catch(async (err) => {
  console.error('Fatal error seeding wallets:', err);
  await db.end();
  process.exit(1);
});
