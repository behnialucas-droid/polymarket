import { getDb } from '../src/lib/db.ts';
import { getAdapter } from './pipeline.ts';
import { updateOpenPnl } from '../src/lib/engine/paperTrading.ts';

const db = getDb();
const adapter = getAdapter();
try {
  const n = await updateOpenPnl(db, adapter);
  console.log(`updated PnL for ${n} open paper trades`);
} catch (e: any) {
  console.error('PNL UPDATE FAILED:', e.message ?? e);
  process.exit(1);
}
