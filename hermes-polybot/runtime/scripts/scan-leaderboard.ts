import { getDb } from '../src/lib/db.ts';
import { getAdapter, runLeaderboardScan } from './pipeline.ts';

const db = getDb();
const adapter = getAdapter();
const limit = Number(process.env.LEADERBOARD_LIMIT ?? 500);
try {
  const n = await runLeaderboardScan(db, adapter, limit);
  console.log(`leaderboard scan (${adapter.source}${adapter.isDemo ? ' DEMO' : ''}): ${n} wallets`);
} catch (e: any) {
  console.error('LEADERBOARD SCAN FAILED (real error, not faking data):', e.message ?? e);
  process.exit(1);
}
