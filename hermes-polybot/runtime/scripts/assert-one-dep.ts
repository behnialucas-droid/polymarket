/**
 * Dependency Guard — Foundation v2 Phase 6 §8.4
 *
 * Verifies that runtime/ depends ONLY on postgres and resolves to exactly 1 package.
 * Wired into CI to prevent anyone from adding dependencies that inflate install time
 * past the 60-second GitHub Actions billing boundary.
 */

import { readFileSync } from 'node:fs';

const ALLOWED = new Set(['postgres']);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

const declared = Object.keys(pkg.dependencies ?? {});
const extra = declared.filter((d) => !ALLOWED.has(d));
if (extra.length > 0) {
  console.error(
    `FATAL: runtime/ may only depend on ${[...ALLOWED].join(', ')}. Found extra: ${extra.join(', ')}`
  );
  console.error(
    'Adding a dependency here can push the job past the 60s billing boundary and double the monthly cost.'
  );
  process.exit(1);
}

const resolved = Object.keys(lock.packages ?? {}).filter((p) => p.startsWith('node_modules/'));
if (resolved.length > 1) {
  console.error(
    `FATAL: lockfile resolves ${resolved.length} packages, expected 1:\n${resolved.join('\n')}`
  );
  process.exit(1);
}

console.log('runtime dependency guard: OK (1 package)');
