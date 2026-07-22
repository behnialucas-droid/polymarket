/** POST /api/cycle — fires the full pipeline (loop-once.ts) as a background process.
 * Returns immediately so the browser never times out.
 * GET returns the last cycle result for status polling. */
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

let running = false;
let lastResult = 'not run yet';
let lastRunAt = '';

export async function GET() {
  return NextResponse.json({ running, lastResult, lastRunAt });
}

export async function POST() {
  if (running) {
    return NextResponse.json({ ok: false, error: 'cycle already running', lastResult, lastRunAt }, { status: 429 });
  }
  running = true;
  lastRunAt = new Date().toLocaleTimeString();

  const root = path.resolve(process.cwd());
  const args = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', path.join(root, 'scripts', 'loop-once.ts')];
  const child = spawn(
    process.execPath,
    args,
    { cwd: root, env: { ...process.env }, stdio: 'pipe', detached: false }
  );

  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('close', (code) => {
    running = false;
    lastResult = code === 0 ? out.trim() : `ERROR: ${out.trim().slice(-300)}`;
    console.log(`[/api/cycle] done (exit ${code}): ${lastResult}`);
  });
  child.on('error', (e) => {
    running = false;
    lastResult = `spawn error: ${e.message}`;
  });

  // Return immediately — client polls GET /api/cycle for status
  return NextResponse.json({ ok: true, message: 'cycle started', pid: child.pid, startedAt: lastRunAt });
}
