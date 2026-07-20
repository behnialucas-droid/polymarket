/** Single-cycle runner called by /api/cycle. Runs one full pipeline cycle then exits.
 * Output is captured by the API route and returned as JSON. */
import { getDb } from '../src/lib/db.ts';
import { getAdapter, runLeaderboardScan, profileWallet, monitorTrades, scoreNewTrades } from './pipeline.ts';
import { updateOpenPnl, reviewOutcomes } from '../src/lib/engine/paperTrading.ts';
import { autoUpdateRules } from '../src/lib/engine/rules.ts';

const db = getDb();
const adapter = getAdapter();
const now = new Date();
const day = now.toISOString().slice(0, 10);
const hour = now.getUTCHours();
const parts: string[] = [];

// State file to persist day/hour across API calls
import { readFileSync, writeFileSync } from 'node:fs';
const stateFile = './data/.cycle-state.json';
let state = { lastLeaderboardDay: '', lastRulesHour: -1 };
try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first run */ }

// Once per day: leaderboard + wallet profiles
if (day !== state.lastLeaderboardDay) {
  const n = await runLeaderboardScan(db, adapter, Number(process.env.LEADERBOARD_LIMIT ?? 500));
  parts.push(`leaderboard:${n}`);
  const top = db.prepare('SELECT address FROM WalletProfile ORDER BY sourceRank LIMIT ?')
    .all(Number(process.env.WALLET_SCAN_LIMIT ?? 50)) as any[];
  for (const w of top) await profileWallet(db, adapter, w.address);
  parts.push(`profiled:${top.length}`);
  state.lastLeaderboardDay = day;
}

// Every cycle: monitor + score + pnl + outcomes
const observed = await monitorTrades(db, adapter);
const { scored, copied } = await scoreNewTrades(db, adapter);
const pnlUpdated = await updateOpenPnl(db, adapter);
const resolved = await reviewOutcomes(db, adapter);
parts.push(`observed:${observed}`, `scored:${scored}`, `copied:${copied}`, `pnl:${pnlUpdated}`, `resolved:${resolved}`);

// Once per hour: rule updates
if (hour !== state.lastRulesHour) {
  const changes = autoUpdateRules(db);
  if (changes.length) parts.push(`rules:${changes.length} changed`);
  state.lastRulesHour = hour;
}

// Save state
try { writeFileSync(stateFile, JSON.stringify(state)); } catch { /* ignore */ }

console.log(parts.join(' '));
