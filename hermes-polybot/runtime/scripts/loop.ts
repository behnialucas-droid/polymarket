/**
 * Continuous local operator loop.
 * Runs one cycle then the report every 15 minutes (same pair as
 * docs/hermes-runner.service ExecStart/ExecStartPost), for hosts without
 * systemd or GitHub Actions. Cycle overlap is prevented by the DB RunLock lease.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const INTERVAL = 15 * 60 * 1000;

console.log('Hermes Polybot local loop starting. Cycle + report every 15 minutes...');

function runScript(script: string): void {
  const root = path.resolve(process.cwd());
  const res = spawnSync('node', [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    path.join(root, 'scripts', script),
  ], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (res.error) console.error(`${script} spawn error:`, res.error);
  else if (res.status !== 0) console.error(`${script} exited with status ${res.status}`);
}

async function run() {
  for (;;) {
    console.log(`\n[${new Date().toISOString()}] Starting cycle...`);
    try {
      runScript('cycle.ts');
      runScript('report-hourly.ts');
    } catch (e: any) {
      console.error('CYCLE FAILED:', e.message ?? e);
    }
    console.log('Sleeping for 15 minutes...');
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

run().catch(console.error);
