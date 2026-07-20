import { getDb } from '../src/lib/db.ts';
import { autoUpdateRules, getActiveRules } from '../src/lib/engine/rules.ts';

const db = getDb();
const changes = autoUpdateRules(db);
const { version } = getActiveRules(db);
if (changes.length) {
  console.log(`applied ${changes.length} rule changes, now at version ${version}:`);
  for (const c of changes) console.log(' -', c);
} else {
  console.log(`no rule changes warranted (version ${version} stays active)`);
}
