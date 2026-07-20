/** Continuous operator loop: full pipeline cycle every LOOP_INTERVAL_SECONDS (default 60).
 * Fail loud per cycle; one failed cycle prints real error, next cycle still runs
 * (transient network blips must not kill the daemon), but consecutive failures >= 5 exit. */
import { getDb } from '../src/lib/db.ts';
import { getAdapter, runLeaderboardScan, profileWallet, monitorTrades, scoreNewTrades } from './pipeline.ts';
import { updateOpenPnl, reviewOutcomes } from '../src/lib/engine/paperTrading.ts';
import { autoUpdateRules } from '../src/lib/engine/rules.ts';
import { buildDailyReport, saveDailyReport, sendTelegram } from '../src/lib/engine/reports.ts';

const INTERVAL = Number(process.env.LOOP_INTERVAL_SECONDS ?? 60) * 1000;
const db = getDb();
const adapter = getAdapter();

let cycle = 0;
let consecutiveFailures = 0;
let lastLeaderboardDay = '';
let lastRulesHour = -1;
let lastReportDay = '';

async function runCycle(): Promise<void> {
  cycle++;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  const t0 = Date.now();
  const parts: string[] = [];

  // daily: leaderboard + wallet profiles
  if (day !== lastLeaderboardDay) {
    const n = await runLeaderboardScan(db, adapter, Number(process.env.LEADERBOARD_LIMIT ?? 500));
    parts.push(`leaderboard:${n}`);
    const top = db.prepare('SELECT address FROM WalletProfile ORDER BY sourceRank LIMIT ?')
      .all(Number(process.env.WALLET_SCAN_LIMIT ?? 50)) as any[];
    for (const w of top) await profileWallet(db, adapter, w.address);
    parts.push(`profiled:${top.length}`);
    lastLeaderboardDay = day;
  }

  // every minute: monitor + score + pnl + outcomes
  const observed = await monitorTrades(db, adapter);
  const { scored, copied } = await scoreNewTrades(db, adapter);
  const pnlUpdated = await updateOpenPnl(db, adapter);
  const resolved = await reviewOutcomes(db, adapter);
  parts.push(`observed:${observed}`, `scored:${scored}`, `copied:${copied}`, `pnl:${pnlUpdated}`, `resolved:${resolved}`);

  // hourly: rule updates
  if (hour !== lastRulesHour) {
    const changes = autoUpdateRules(db);
    if (changes.length) parts.push(`rules:${changes.length} changed`);
    lastRulesHour = hour;
  }

  // daily 22:00 UTC: report
  if (hour >= 22 && day !== lastReportDay) {
    const report = buildDailyReport(db, day);
    let sent = false;
    try { sent = await sendTelegram(`Hermes Polybot daily report ${day}\n\n${report.summary}`); }
    catch (e: any) { console.error('TELEGRAM SEND FAILED:', e.message ?? e); }
    saveDailyReport(db, report, sent, adapter.isDemo);
    parts.push('report:saved');
    lastReportDay = day;
  }

  console.log(`[${now.toISOString()}] cycle ${cycle} ok (${Date.now() - t0}ms) ${parts.join(' ')}`);
}

console.log(`Hermes Polybot loop starting (${adapter.source}${adapter.isDemo ? ' DEMO' : ''}, every ${INTERVAL / 1000}s). PAPER TRADING ONLY.`);
for (;;) {
  try {
    await runCycle();
    consecutiveFailures = 0;
  } catch (e: any) {
    consecutiveFailures++;
    console.error(`CYCLE FAILED (${consecutiveFailures} consecutive, real error, not faking data):`, e.message ?? e);
    if (consecutiveFailures >= 10) {
      console.error('10 consecutive failures — stopping loop. Fix the API issue and restart.');
      process.exit(1);
    }
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
