import { getDb } from '../src/lib/db.ts';
import { getAdapter, profileWallet } from './pipeline.ts';

const db = getDb();
const adapter = getAdapter();

async function main() {
  const wallets = await db`
    SELECT "address", "sourceRank" 
    FROM "WalletProfile" 
    ORDER BY "sourceRank" ASC NULLS LAST 
    LIMIT 500
  `;

  console.log(`🚀 Starting 30-Day Trade Analysis & Copyability Scoring for ${wallets.length} Wallets...`);

  const BATCH_SIZE = 10;
  let ok = 0;
  let errCount = 0;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (w) => {
        try {
          await profileWallet(db, adapter, w.address);
          ok++;
        } catch (err: any) {
          errCount++;
        }
      })
    );

    const pct = Math.round((ok / wallets.length) * 100);
    process.stdout.write(`\rProgress: ${ok}/${wallets.length} scored (${pct}%) [${errCount} skipped]`);
  }

  console.log(`\n\n======================================================`);
  console.log(`🎉 500-WALLET 30-DAY PROFILING & SUPABASE SYNC COMPLETE`);
  
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

  console.log(` Total Scored Wallets: ${scoredCount[0].count}`);
  for (const r of statusCounts) {
    console.log(` • Status '${r.status}': ${r.count} wallets`);
  }
  console.log(`======================================================\n`);

  await db.end();
}

main().catch(async (e) => {
  console.error('Profiling error:', e);
  await db.end();
  process.exit(1);
});
