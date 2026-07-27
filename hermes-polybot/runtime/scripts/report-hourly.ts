/**
 * Hourly report script — Foundation v2 Phase 3 Deliverable
 *
 * Runs hourly from GitHub Actions (`hourly.yml`).
 *
 * Sequence:
 *   1. Auto-update rules pass (engine untouched)
 *   2. Staleness watchdog — reads Heartbeat table
 *   3. Rescan due-check — runs inside an already-billed minute
 *   4. Telegram report — ALWAYS sends, even when degraded
 *   5. Heartbeat record for 'hourly'
 *
 * Exit code is 1 if watchdog found problems, so GitHub Actions UI turns red.
 * The message arrives REGARDLESS of health. Conflating delivery with health
 * is how silent crash windows happen.
 */

import { getDb } from '../src/lib/db.ts';
import { readHeartbeats, heartbeat } from '../src/lib/heartbeat.ts';
import { sendTelegram } from '../src/lib/telegram.ts';
import { buildReport } from '../src/lib/report.ts';
import { autoUpdateRules, getActiveRules } from '../src/lib/engine/rules.ts';
import { redact, num, optional, bool } from '../src/lib/env.ts';

async function main(): Promise<void> {
  const t0 = Date.now();
  const db = getDb();
  const problems: string[] = [];

  // --- 1. Rules pass ---
  let rulesVersion = 'v1';
  let rulesTriggered = 0;
  try {
    const changes = await autoUpdateRules(db);
    const { rules } = await getActiveRules(db);
    rulesVersion = rules.version ? `v${rules.version}` : 'v1';
    rulesTriggered = changes.length;
  } catch (e: unknown) {
    problems.push(`rules pass error: ${redact(e)}`);
  }

  // --- 2. Staleness watchdog ---
  try {
    const beats = await readHeartbeats();
    const maxAgeMin = num('CYCLE_MAX_AGE_MIN', 150);
    const nowMs = Date.now();

    for (const b of beats) {
      const lastOk = b.lastOkAt ? new Date(b.lastOkAt).getTime() : 0;
      const lastRun = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
      const effectiveLast = lastOk || lastRun;

      if (effectiveLast > 0) {
        const ageMin = (nowMs - effectiveLast) / 60_000;
        if (ageMin > maxAgeMin) {
          problems.push(`${b.name} has not succeeded for ${Math.round(ageMin)} min`);
        }
      }
      if (b.consecutiveFailures >= 3) {
        problems.push(
          `${b.name} failed ${b.consecutiveFailures}x in a row: ${b.lastError ?? 'unknown error'}`
        );
      }
    }
  } catch (e: unknown) {
    problems.push(`watchdog query error: ${redact(e)}`);
  }

  // --- 3. Rescan due-check ---
  let rescanNote = 'not due';
  if (bool('RESCAN_ENABLED', true)) {
    try {
      // Import dynamically or check RescanRun directly
      const [rescanRunRow] = await db`
        SELECT coalesce(max("generation"), 0)::int AS "lastGen",
               max("completedAt") FILTER (WHERE "status" IN ('complete','degraded')) AS "lastCompletedAt",
               coalesce(bool_or("status" = 'running'), false) AS "inProgress"
        FROM "RescanRun"
      `;

      const lastMs = rescanRunRow?.lastCompletedAt ? new Date(rescanRunRow.lastCompletedAt).getTime() : 0;
      const elapsedDays = lastMs > 0 ? (t0 - lastMs) / 86_400_000 : 999;
      const intervalDays = num('RESCAN_INTERVAL_DAYS', 30);
      const isDue = !rescanRunRow?.inProgress && elapsedDays >= intervalDays;

      if (isDue) {
        rescanNote = `DUE (elapsed ${elapsedDays.toFixed(1)}d >= ${intervalDays}d)`;
      } else if (rescanRunRow?.inProgress) {
        rescanNote = `in progress (gen ${rescanRunRow.lastGen})`;
      } else {
        const remaining = Math.max(0, intervalDays - elapsedDays);
        rescanNote = `next in ${remaining.toFixed(1)}d`;
      }
    } catch {
      rescanNote = 'status check error';
    }
  }

  // --- 4. Telegram report (ALWAYS sends) ---
  const tz = optional('REPORT_TZ', 'UTC') ?? 'UTC';
  const reportText = await buildReport({
    rules: { version: rulesVersion, triggered: rulesTriggered },
    problems,
    rescanNote,
    tz,
  });

  try {
    await sendTelegram(reportText);
    console.log('Telegram report sent successfully');
  } catch (e: unknown) {
    console.error('Telegram report failed:', redact(e));
    problems.push(`Telegram send failed: ${redact(e)}`);
  }

  // --- 5. Heartbeat record for hourly ---
  const isHealthy = problems.length === 0;
  await heartbeat('hourly', isHealthy, problems.join('; ') || null, {
    durationMs: Date.now() - t0,
    rescanNote,
    problemsCount: problems.length,
  });

  // Non-zero exit code if watchdog found problems (turns Actions UI red)
  if (!isHealthy) {
    console.warn(`report-hourly completed with ${problems.length} problem(s)`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (e: unknown) {
  console.error('report-hourly fatal unhandled exception:', redact(e));
  process.exitCode = 1;
} finally {
  const db = getDb();
  await db.end({ timeout: 5 });
}
