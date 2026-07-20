/** 
 * Continuous SMC-style operator loop.
 * Runs loop-once.ts every 5 minutes automatically, ensuring 24/7 uptime
 * and triggering the hourly Telegram reports reliably without needing a web browser open.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const INTERVAL = 5 * 60 * 1000; // 5 minutes

console.log(`Hermes Polybot SMC Daemon starting. Running cycle every 5 minutes...`);

async function run() {
  const root = path.resolve(process.cwd());
  for (;;) {
    console.log(`\n[${new Date().toISOString()}] Starting autonomous cycle...`);
    try {
      const res = spawnSync('node', [
        '--env-file=.env', 
        '--experimental-strip-types', 
        '--disable-warning=ExperimentalWarning', 
        path.join(root, 'scripts', 'loop-once.ts')
      ], { 
        cwd: root, 
        stdio: 'inherit',
        env: { ...process.env }
      });
      
      if (res.error) {
        console.error('Cycle spawn error:', res.error);
      }
    } catch (e: any) {
      console.error(`CYCLE FAILED:`, e.message ?? e);
    }
    
    console.log(`Sleeping for 5 minutes...`);
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

run().catch(console.error);
