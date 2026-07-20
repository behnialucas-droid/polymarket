import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = process.env.DATABASE_PATH ?? join(ROOT, 'data', 'polybot.db');

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 10000;
    PRAGMA synchronous = NORMAL;
  `);
  migrate(db);
  return db;
}

export function openMemoryDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  migrate(d);
  return d;
}

export function migrate(d: DatabaseSync): void {
  const dir = join(ROOT, 'db', 'migrations');
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.sql')) d.exec(readFileSync(join(dir, f), 'utf8'));
  }
}
