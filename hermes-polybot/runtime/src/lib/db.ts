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
    max: 3,
    idle_timeout: 20,           // Give connections more time before returning to pool
    connect_timeout: 30,        // Increased from 20 — Supabase cold starts need more time
    max_lifetime: 60 * 15,      // 15 min cap — conservative for PgBouncer recycling
    keep_alive: 10,             // TCP keepalive probes every 10s — prevents ETIMEDOUT on idle
    keep_alive_delay: 30,       // Start keepalive after 30s idle
    prepare: false,             // REQUIRED for PgBouncer transaction pooling
    ssl: 'require',
    onnotice: () => {},
    // When PgBouncer drops a connection, clear the singleton so next call
    // creates a fresh pool rather than retrying on dead socket.
    onclose: () => { sql = null; },
  });

  return sql;
}

/**
 * Reset the DB singleton — call this after catching a connection error
 * so the next getDb() creates a fresh pool instead of reusing a dead one.
 */
export function resetDb(): void {
  if (sql) {
    try { sql.end({ timeout: 2 }).catch(() => {}); } catch { /* ignore */ }
    sql = null;
  }
}

/**
 * Execute an async database operation with exponential back-off retry.
 *
 * Retries on transient TCP errors (ETIMEDOUT, ECONNRESET, ECONNREFUSED, EPIPE).
 * On each retry the DB singleton is reset so a fresh connection is established.
 *
 * @param fn     The operation to retry (receives a fresh db handle each attempt)
 * @param label  Name for logging
 * @param maxAttempts  Default 3
 */
export async function withDbRetry<T>(
  fn: (db: postgres.Sql) => Promise<T>,
  label = 'db-op',
  maxAttempts = 3,
): Promise<T> {
  const RETRYABLE = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|Connection terminated|socket hang up|CONNECTION_CLOSED/i;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const db = getDb();
      return await fn(db);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isRetryable = RETRYABLE.test(msg);
      const isLast = attempt >= maxAttempts;

      if (isRetryable && !isLast) {
        const waitMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
        console.warn(`[${label}] transient DB error (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms: ${msg.slice(0, 120)}`);
        resetDb();
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // Not retryable, or last attempt — always reset pool on failure
      if (isRetryable) resetDb();
      throw e;
    }
  }
  // Unreachable — TypeScript needs this
  throw new Error(`${label}: all ${maxAttempts} attempts exhausted`);
}

export async function migrate(d: postgres.Sql): Promise<void> {
  const dir = join(ROOT, 'db', 'migrations');
  const sql = await d.reserve();
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "SchemaMigration" (
        "id"          SERIAL PRIMARY KEY,
        "version"     TEXT NOT NULL UNIQUE,
        "appliedAt"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "description" TEXT
      );
    `);

    const rows = await sql<{ version: string }[]>`SELECT "version" FROM "SchemaMigration"`;
    const applied = new Set(rows.map((r) => r.version));

    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.sql')) {
        const version = f.split('_')[0];
        if (applied.has(version)) {
          continue;
        }
        console.log(`Applying migration ${f}...`);
        const query = readFileSync(join(dir, f), 'utf8');
        await sql.unsafe(query);
        await sql`INSERT INTO "SchemaMigration" ("version", "description") VALUES (${version}, ${f}) ON CONFLICT ("version") DO NOTHING`;
      }
    }
  } finally {
    sql.release();
  }
}
