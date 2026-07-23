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

// Load state from Postgres SystemState table instead of local filesystem
let state = { lastLeaderboardDay: '', lastRulesHour: -1, lastTelegramHour: -1 };
try {
  const stateRows = await db`SELECT "valueJson" FROM "SystemState" WHERE "keyName" = 'cycle_state'`;
  if (stateRows.length > 0) {
    state = { ...state, ...JSON.parse(stateRows[0].valueJson) };
  }
} catch (e: any) {
  console.error("Failed to load SystemState:", e);
}

// Once per day: leaderboard scan
if (day !== state.lastLeaderboardDay) {
  const n = await runLeaderboardScan(db, adapter, Number(process.env.LEADERBOARD_LIMIT ?? 500));
  parts.push(`leaderboard:${n}`);
  state.lastLeaderboardDay = day;
}

// Every cycle: profile a batch of unprofiled/zero-trade wallets until all 500 are completed
const unprofiled = await db`
  SELECT "address" FROM "WalletProfile" 
  WHERE "globalScore" IS NULL OR "tradeCount30d" = 0 OR "tradeCount30d" IS NULL
  ORDER BY "sourceRank" ASC NULLS LAST 
  LIMIT ${Number(process.env.WALLET_SCAN_LIMIT ?? 20)}
`;
if (unprofiled.length > 0) {
  for (const w of unprofiled) {
    try { await profileWallet(db, adapter, w.address); } catch {}
  }
  parts.push(`profiled:${unprofiled.length}`);
}

// Every cycle: monitor + score + pnl + outcomes
const observed = await monitorTrades(db, adapter);
const { scored, copied } = await scoreNewTrades(db, adapter);
const pnlUpdated = await updateOpenPnl(db, adapter);
const resolved = await reviewOutcomes(db, adapter);
parts.push(`observed:${observed}`, `scored:${scored}`, `copied:${copied}`, `pnl:${pnlUpdated}`, `resolved:${resolved}`);

// Once per hour: rule updates & Telegram report
if (hour !== state.lastRulesHour) {
  const changes = await autoUpdateRules(db);
  if (changes.length) parts.push(`rules:${changes.length} changed`);
  state.lastRulesHour = hour;
}

if (hour !== state.lastTelegramHour) {
  try {
    const { runHourlyReport } = await import('./report-telegram.ts');
    await runHourlyReport();
    parts.push('telegram:sent');
  } catch (e: any) {
    console.error("Hourly Telegram report error:", e?.message || e);
  }
  state.lastTelegramHour = hour;
}

// Save state to Postgres
try {
  await db`
    INSERT INTO "SystemState" ("keyName", "valueJson")
    VALUES ('cycle_state', ${JSON.stringify(state)})
    ON CONFLICT("keyName") DO UPDATE SET "valueJson" = EXCLUDED."valueJson", "updatedAt" = CURRENT_TIMESTAMP
  `;
} catch (e: any) {
  console.error("Failed to save cycle state to Postgres:", e);
}

console.log(parts.join(' '));
