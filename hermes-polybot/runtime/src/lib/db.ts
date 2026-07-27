import postgres from 'postgres';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnvFile() {
  if (process.env.DATABASE_URL) return;
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '.env'),
    join(currentDir, '.env'),
    join(currentDir, '..', '.env'),
    join(currentDir, '..', '..', '.env'),
    join(currentDir, '..', '..', '..', '.env'),
  ];
  for (const envPath of candidatePaths) {
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
      if (process.env.DATABASE_URL) return;
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
    // PgBouncer transaction-pool mode: keep max low to avoid exhausting the pool
    // and avoid ECONNRESET from idle-connection reaping
    max: 3,
    idle_timeout: 10,     // Return idle connections to pool quickly
    connect_timeout: 20,
    max_lifetime: 60 * 20, // 20 min cap — PgBouncer recycles after 30 min
    keep_alive: 5,        // TCP keepalive probes every 5s
    prepare: false,       // REQUIRED for PgBouncer transaction pooling
    ssl: 'require',
    onnotice: () => {},
    // When PgBouncer drops a connection, clear the singleton so next call
    // creates a fresh pool rather than retrying on dead socket
    onclose: () => { sql = null; },
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
