import { getDb } from '../src/lib/db.ts';
import { autoUpdateRules, getActiveRules } from '../src/lib/engine/rules.ts';

const db = getDb();
try {
  const changes = await autoUpdateRules(db);
  const { version } = await getActiveRules(db);
  if (changes.length) {
    console.log(`applied ${changes.length} rule changes, now at version ${version}:`);
    for (const c of changes) console.log(' -', c);
  } else {
    console.log(`no rule changes warranted (version ${version} stays active)`);
  }
} catch (e: any) {
  console.error('RULE UPDATE FAILED:', e.message ?? e);
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 }).catch(() => {});
}
