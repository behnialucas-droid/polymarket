import { PolymarketAdapter } from '../src/lib/adapters/polymarket.ts';
import { profileWallet } from './pipeline.ts';
import { getDb } from '../src/lib/db.ts';

async function main() {
  const db = getDb();
  const adapter = new PolymarketAdapter();
  
  const wallets = await db`SELECT "address", "sourceRank" FROM "WalletProfile" ORDER BY "sourceRank" ASC NULLS LAST`;
  console.log(`Starting full refresh of all ${wallets.length} wallets in Supabase...`);
  
  let success = 0;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    try {
      await profileWallet(db, adapter, w.address);
      success++;
      if (success % 10 === 0 || i === wallets.length - 1) {
        console.log(`[Progress] Refreshed ${success}/${wallets.length} wallets (${Math.round((success / wallets.length) * 100)}%)`);
      }
    } catch (e: any) {
      console.warn(`[Warning] Failed to refresh wallet rank ${w.sourceRank} (${w.address}):`, e?.message ?? e);
    }
  }
  
  console.log(`======================================================`);
  console.log(`🎉 FULL REFRESH COMPLETE: ${success}/${wallets.length} wallets updated!`);
  console.log(`======================================================`);
  await db.end();
}

main().catch(console.error);
