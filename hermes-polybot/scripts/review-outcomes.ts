import { getDb } from '../src/lib/db.ts';
import { getAdapter } from './pipeline.ts';
import { reviewOutcomes } from '../src/lib/engine/paperTrading.ts';

const db = getDb();
const adapter = getAdapter();
try {
  const n = await reviewOutcomes(db, adapter);
  console.log(`resolved + reviewed ${n} paper trades`);
} catch (e: any) {
  console.error('OUTCOME REVIEW FAILED:', e.message ?? e);
  process.exit(1);
}
