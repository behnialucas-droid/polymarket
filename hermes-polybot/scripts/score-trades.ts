import { getDb } from '../src/lib/db.ts';
import { getAdapter, scoreNewTrades } from './pipeline.ts';

const db = getDb();
const adapter = getAdapter();
try {
  const { scored, copied } = await scoreNewTrades(db, adapter);
  console.log(`scored ${scored} trades, opened ${copied} paper copies`);
} catch (e: any) {
  console.error('TRADE SCORING FAILED:', e.message ?? e);
  process.exit(1);
}
