/**
 * Hourly report script — Foundation v2 Phase 3 Deliverable
 *
 * Runs hourly from GitHub Actions (`hourly.yml`).
 *
 * Sequence:
 *   1. Auto-update rules pass (engine untouched)
 *   2. Staleness watchdog — reads Heartbeat table
 *   3. Rescan due-check — if due, AUTO-DISPATCHES next generation
 *   4. Telegram report — ALWAYS sends, even when degraded
 *   5. Heartbeat record for 'hourly'
 *
 * Exit code is 1 if watchdog found problems, so GitHub Actions UI turns red.
 * The message arrives REGARDLESS of health. Conflating delivery with health
 * is how silent crash windows happen.
 */

import { getDb, resetDb } from '../src/lib/db.ts';
import { readHeartbeats, heartbeat } from '../src/lib/heartbeat.ts';
import { sendTelegram } from '../src/lib/telegram.ts';
import { buildReport } from '../src/lib/report.ts';
import { autoUpdateRules, getActiveRules } from '../src/lib/engine/rules.ts';
import { isRescanDue, openGeneration, dispatchRescan } from '../src/lib/rescan.ts';
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
      // Only report consecutiveFailures if it's >= 3 AND include only the first line of the error
      // to avoid cascade-nesting previous reports inside this one.
      if (b.consecutiveFailures >= 3) {
        const errFirstLine = (b.lastError ?? 'unknown error').split('\n')[0].trim().slice(0, 200);
        problems.push(
          `${b.name} failed ${b.consecutiveFailures}x in a row: ${errFirstLine}`
        );
      }
    }
  } catch (e: unknown) {
    problems.push(`watchdog query error: ${redact(e)}`);
  }

  // --- 3. Rescan due-check + AUTO-DISPATCH ---
  let rescanNote = 'not due';
  if (bool('RESCAN_ENABLED', true)) {
    try {
      const intervalDays = num('RESCAN_INTERVAL_DAYS', 30);
      const due = await isRescanDue(intervalDays);

      if (due.inProgress) {
        rescanNote = `in progress (gen ${due.lastGeneration})`;
      } else if (due.isDue) {
        const nextGen = due.lastGeneration + 1;
        rescanNote = `DUE (elapsed ${(due.daysRemaining <= 0 ? intervalDays + Math.abs(due.daysRemaining) : intervalDays).toFixed(1)}d >= ${intervalDays}d) → dispatching gen ${nextGen}`;

        // Check WORKFLOW_DISPATCH_TOKEN is configured before trying
        const token = optional('WORKFLOW_DISPATCH_TOKEN');
        if (!token) {
          problems.push('rescan is DUE but WORKFLOW_DISPATCH_TOKEN is not set — cannot dispatch');
          rescanNote = `DUE but dispatch blocked (missing WORKFLOW_DISPATCH_TOKEN)`;
        } else {
          try {
            // Open the generation row in DB before dispatching
            await openGeneration(nextGen);
            await dispatchRescan(nextGen, 1);
            console.log(`Rescan generation ${nextGen} dispatched (chunk 1)`);
            rescanNote = `dispatching gen ${nextGen} chunk 1`;
          } catch (e: unknown) {
            const dispatchErr = redact(e).split('\n')[0].trim().slice(0, 150);
            problems.push(`rescan dispatch failed: ${dispatchErr}`);
            rescanNote = `DUE but dispatch failed`;
          }
        }
      } else {
        rescanNote = `next in ${due.daysRemaining.toFixed(1)}d`;
      }
    } catch (e: unknown) {
      rescanNote = 'status check error';
      problems.push(`rescan check error: ${redact(e).split('\n')[0].slice(0, 150)}`);
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
    problems.push(`Telegram send failed: ${redact(e).split('\n')[0].slice(0, 100)}`);
  }

  // --- 5. Heartbeat record for hourly ---
  const isHealthy = problems.length === 0;
  await heartbeat('hourly', isHealthy, problems.length > 0 ? problems[0] : null, {
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
  resetDb();
  process.exitCode = 1;
} finally {
  const db = getDb();
  await db.end({ timeout: 5 });
}
