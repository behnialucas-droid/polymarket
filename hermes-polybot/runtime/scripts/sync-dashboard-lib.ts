/** Deterministic one-way mirror: runtime/src/lib -> dashboard/src/lib for the
 * SHARED pure-logic modules (engine, adapters, classify, research, readModel,
 * decision evidence). Runtime is authoritative; dashboard copies are generated.
 * App-specific modules (db, env, telegram, queries, report, memory, heartbeat,
 * failures, rescan) stay per-app and are NOT mirrored.
 *
 *   --check  exit 1 if any mirrored file differs (wired into npm test / CI)
 *   --write  regenerate the dashboard copies
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib');
const DASHBOARD_LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'src', 'lib');

const HEADER = '// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib\n';

const MIRRORED_DIRS = ['engine', 'adapters', 'research'];
const MIRRORED_FILES = ['classify.ts', 'readModel.ts'];

function listMirroredFiles(): string[] {
  const files: string[] = [];
  for (const dir of MIRRORED_DIRS) {
    const full = join(RUNTIME_LIB, dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full).sort()) {
      if (f.endsWith('.ts')) files.push(join(dir, f));
    }
  }
  for (const f of MIRRORED_FILES) {
    if (existsSync(join(RUNTIME_LIB, f))) files.push(f);
  }
  return files;
}

function generatedContent(relPath: string): string {
  return HEADER + readFileSync(join(RUNTIME_LIB, relPath), 'utf8');
}

const mode = process.argv.includes('--write') ? 'write' : 'check';
const files = listMirroredFiles();
let drift = 0;

for (const relPath of files) {
  const target = join(DASHBOARD_LIB, relPath);
  const expected = generatedContent(relPath);
  const actual = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (actual === expected) continue;
  if (mode === 'write') {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, expected);
    console.log(`synced ${relPath}`);
  } else {
    console.error(`DRIFT: dashboard/src/lib/${relPath} differs from runtime source of truth`);
    drift++;
  }
}

if (mode === 'check') {
  if (drift > 0) {
    console.error(`${drift} mirrored file(s) drifted. Run: node --experimental-strip-types scripts/sync-dashboard-lib.ts --write`);
    process.exit(1);
  }
  console.log(`dashboard lib mirror clean (${files.length} files)`);
} else {
  console.log(`mirror complete (${files.length} files)`);
}
