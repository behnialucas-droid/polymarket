import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const dbUrl = process.env.DATABASE_URL || '';
let sql: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (sql) return sql;
  
  if (!dbUrl) {
    console.warn('DATABASE_URL is not set. Database connection will fail.');
  }

  sql = postgres(dbUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  
  return sql;
}

export async function migrate(d: postgres.Sql): Promise<void> {
  const dir = join(ROOT, 'db', 'migrations');
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.sql')) {
      const query = readFileSync(join(dir, f), 'utf8');
      await d.unsafe(query);
    }
  }
}
