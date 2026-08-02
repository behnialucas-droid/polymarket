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

import { getDb, withDbRetry, resetDb } from '../src/lib/db.ts';
import { getAdapter, monitorTrades, scoreNewTrades } from './pipeline.ts';
import { updateOpenPnl, updateSignedMarks, reviewOutcomes } from '../src/lib/engine/paperTrading.ts';
import { recordResolutionEvidence, finalizeSettlements } from '../src/lib/engine/settlementDb.ts';
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
    const lockRows = await withDbRetry(
      (d) => d`
        UPDATE "RunLock"
           SET "acquiredAt" = (NOW() AT TIME ZONE 'UTC'),
               "acquiredBy" = ${RUN_ID},
               "expiresAt"  = (NOW() AT TIME ZONE 'UTC') + INTERVAL '10 minutes'
         WHERE "name" = 'cycle'
           AND ("expiresAt" IS NULL OR "expiresAt" < (NOW() AT TIME ZONE 'UTC') OR "acquiredBy" = ${RUN_ID})
         RETURNING "name"
      `,
      'acquireCycleLock',
    );
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
    const observed = await withDbRetry(
      (db) => monitorTrades(db, adapter),
      'monitorTrades',
    );

    // --- 3. Score new trades ---
    const { scored, copied, funnel } = await withDbRetry(
      (db) => scoreNewTrades(db, adapter),
      'scoreNewTrades',
    );

    // --- 4. Update open PnL: legacy frozen book + signed v2 marks ---
    const pnlUpdated = await withDbRetry(
      (db) => updateOpenPnl(db, adapter),
      'updateOpenPnl',
    );
    const marked = await withDbRetry(
      (db) => updateSignedMarks(db, adapter),
      'updateSignedMarks',
    );

    // --- 5. Outcomes: legacy review drains the frozen v1 book; the signed
    // book settles ONLY from confirmed resolution evidence ---
    const resolved = await withDbRetry(
      (db) => reviewOutcomes(db, adapter),
      'reviewOutcomes',
    );
    const evidenced = await withDbRetry(
      (db) => recordResolutionEvidence(db, adapter),
      'recordResolutionEvidence',
    );
    const settled = await withDbRetry(
      (db) => finalizeSettlements(db),
      'finalizeSettlements',
    );

    const durationMs = Date.now() - t0;
    const summary = `observed:${observed} scored:${scored} copied:${copied} funnel:[validSnap:${funnel?.validSnapshot ?? 0}, horizonPass:${funnel?.horizonGatePassed ?? 0}, walletPass:${funnel?.walletGatePassed ?? 0}, admitted:${funnel?.admitted ?? 0}] pnl:${pnlUpdated} marked:${marked} resolved:${resolved} evidence:${evidenced} settled:${settled} timing:${durationMs}ms`;
    console.log(summary);

    await heartbeat('cycle', true, null, {
      observed, scored, copied, funnel, pnlUpdated, marked, resolved, evidenced, settled, durationMs
    });
  } catch (e: unknown) {
    const errStr = redact(e);
    console.error('cycle error:', errStr);
    // Reset DB pool so next run starts fresh
    resetDb();
    await heartbeat('cycle', false, errStr, { durationMs: Date.now() - t0 });
    process.exitCode = 1;
  } finally {
    // Release the lock if we acquired it
    if (lockAcquired) {
      try {
        await db`
          UPDATE "RunLock"
             SET "expiresAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 second'
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
