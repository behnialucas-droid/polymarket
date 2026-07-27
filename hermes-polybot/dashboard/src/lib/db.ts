import postgres from 'postgres';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnvFile() {
  if (process.env.DATABASE_URL) return;
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnvFile();

let sql: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (sql) return sql;
  
  loadEnvFile();
  const dbUrl = process.env.DATABASE_URL || '';
  
  if (!dbUrl) {
    console.warn('DATABASE_URL is not set. Database connection will fail.');
  }

  sql = postgres(dbUrl, {
    max: 10,
    idle_timeout: 15,
    connect_timeout: 30,
    max_lifetime: 60 * 30,
    keep_alive: 10,
    prepare: false, // Required for PgBouncer / Supabase pooler
    ssl: 'require',
    onnotice: () => {},
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
