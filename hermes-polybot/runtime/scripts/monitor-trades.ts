import { getDb } from '../src/lib/db.ts';
import { getAdapter, monitorTrades } from './pipeline.ts';

const db = getDb();
const adapter = getAdapter();
try {
  const n = await monitorTrades(db, adapter);
  console.log(`observed ${n} new trades from tracked wallets`);
} catch (e: any) {
  console.error('TRADE MONITOR FAILED:', e.message ?? e);
  process.exit(1);
}
