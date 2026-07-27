/**
 * Single-cycle runner — Foundation v2 Phase 3 Deliverable
 *
 * Incremental, idempotent, lock-guarded execution cycle.
 * Invoked by GitHub Actions hourly workflow or fast cycle.
 *
 * Runs:
 *   1. Lock acquisition (RunLock table)
 *   2. monitorTrades (high-water mark per tracked wallet + ON CONFLICT DO NOTHING)
 *   3. scoreNewTrades (scores un-journaled observed trades)
 *   4. updateOpenPnl (updates unrealized PnL for open positions, max 1 fetch per market)
 *   5. reviewOutcomes (resolves finished paper trades)
 *   6. Heartbeat record
 *
 * Never commits to git. Never bulk-scans 500 wallets. Exits 0 on lock contention.
 */

import { getDb } from '../src/lib/db.ts';
import { getAdapter, monitorTrades, scoreNewTrades } from './pipeline.ts';
import { updateOpenPnl, reviewOutcomes } from '../src/lib/engine/paperTrading.ts';
import { heartbeat } from '../src/lib/heartbeat.ts';
import { redact, bool } from '../src/lib/env.ts';

const RUN_ID = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;

async function main(): Promise<void> {
  const t0 = Date.now();
  const db = getDb();
  const adapter = getAdapter();

  if (!bool('CYCLE_ENABLED', true)) {
    console.log('skipped: CYCLE_ENABLED is false');
    return;
  }

  // --- 1. Lock acquisition via RunLock row lease ---
  // Avoids pg_advisory_lock which is incompatible with PgBouncer transaction pooling.
  // Lease expires after 10 minutes if runner dies without releasing.
  let lockAcquired = false;
  try {
    const lockRows = await db`
      UPDATE "RunLock"
         SET "acquiredAt" = CURRENT_TIMESTAMP,
             "acquiredBy" = ${RUN_ID},
             "expiresAt"  = CURRENT_TIMESTAMP + INTERVAL '10 minutes'
       WHERE "name" = 'cycle'
         AND ("expiresAt" IS NULL OR "expiresAt" < CURRENT_TIMESTAMP OR "acquiredBy" = ${RUN_ID})
       RETURNING "name"
    `;
    if (lockRows.length === 0) {
      console.log('skipped: cycle lock held');
      await heartbeat('cycle', true, null, { skipped: 'lock_held', durationMs: Date.now() - t0 });
      process.exitCode = 0;
      return;
    }
    lockAcquired = true;
  } catch (e: unknown) {
    console.error('RunLock error:', redact(e));
    console.log('skipped: cycle lock error');
    process.exitCode = 0;
    return;
  }

  try {
    // --- 2. Monitor trades (incremental, per-wallet high-water mark) ---
    const observed = await monitorTrades(db, adapter);

    // --- 3. Score new trades ---
    const { scored, copied } = await scoreNewTrades(db, adapter);

    // --- 4. Update open PnL ---
    const pnlUpdated = await updateOpenPnl(db, adapter);

    // --- 5. Review outcomes ---
    const resolved = await reviewOutcomes(db, adapter);

    const durationMs = Date.now() - t0;
    const summary = `observed:${observed} scored:${scored} copied:${copied} pnl:${pnlUpdated} resolved:${resolved} timing:${durationMs}ms`;
    console.log(summary);

    await heartbeat('cycle', true, null, {
      observed, scored, copied, pnlUpdated, resolved, durationMs
    });
  } catch (e: unknown) {
    const errStr = redact(e);
    console.error('cycle error:', errStr);
    await heartbeat('cycle', false, errStr, { durationMs: Date.now() - t0 });
    process.exitCode = 1;
  } finally {
    // Release the lock if we acquired it
    if (lockAcquired) {
      try {
        await db`
          UPDATE "RunLock"
             SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
           WHERE "name" = 'cycle' AND "acquiredBy" = ${RUN_ID}
        `;
      } catch { /* ignore release error on shutdown */ }
    }
  }
}

try {
  await main();
} catch (e: unknown) {
  console.error('cycle runner unhandled exception:', redact(e));
  process.exitCode = 1;
} finally {
  const db = getDb();
  await db.end({ timeout: 5 });
}
