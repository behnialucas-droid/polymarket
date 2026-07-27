import { getDb, migrate } from '../src/lib/db.ts';

const sql = getDb();
await migrate(sql);
console.log('Supabase database migrations applied successfully.');
await sql.end();
