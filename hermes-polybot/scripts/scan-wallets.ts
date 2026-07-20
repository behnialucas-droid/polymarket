import { getDb } from '../src/lib/db.ts';
import { getAdapter, profileWallet } from './pipeline.ts';

const db = getDb();
const adapter = getAdapter();
const limit = Number(process.env.WALLET_SCAN_LIMIT ?? 50);
const wallets = db.prepare('SELECT address FROM WalletProfile ORDER BY sourceRank LIMIT ?').all(limit) as any[];
let ok = 0;
for (const w of wallets) {
  try {
    await profileWallet(db, adapter, w.address);
    ok++;
  } catch (e: any) {
    console.error(`WALLET SCAN FAILED for ${w.address}:`, e.message ?? e);
    process.exit(1);
  }
}
console.log(`profiled ${ok} wallets (${adapter.source}${adapter.isDemo ? ' DEMO' : ''})`);
