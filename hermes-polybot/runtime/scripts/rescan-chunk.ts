/**
 * Rescan Chunk Runner — Foundation v2 Phase 4 §6.5
 *
 * Runs one chunk of one generation. Resumable, leased, self-chaining.
 * Invoked ONLY by workflow_dispatch (or manually). Never on a cron schedule.
 */

import { getDb } from '../src/lib/db.ts';
import { getAdapter, profileWallet } from './pipeline.ts';
import { classify } from '../src/lib/classify.ts';
import { dispatchRescan } from '../src/lib/rescan.ts';
import { heartbeat } from '../src/lib/heartbeat.ts';
import { sendTelegram } from '../src/lib/telegram.ts';
import { allLimiterStats } from '../src/lib/adapters/rateLimit.ts';
import { redact, num } from '../src/lib/env.ts';

const GENERATION = Number(process.env.RESCAN_GENERATION);
const CHUNK_INDEX = Number(process.env.RESCAN_CHUNK_INDEX ?? '1');
const RUN_ID = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;
const CHUNK_SIZE = num('RESCAN_CHUNK_SIZE', 250);
const MAX_CHUNKS = num('RESCAN_MAX_CHUNKS', 40);  // Raised from 20 — public repo, unlimited minutes
const SOFT_DEADLINE_MS = num('RESCAN_SOFT_DEADLINE_MS', 40 * 60_000); // 40-min soft deadline

if (!Number.isInteger(GENERATION) || GENERATION < 1) {
  throw new Error('FATAL: RESCAN_GENERATION must be a positive integer >= 1');
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const db = getDb();
  const adapter = getAdapter();

  // --- Termination Guard 1: Hard chunk index cap ---
  if (CHUNK_INDEX > MAX_CHUNKS) {
    await db`
      UPDATE "RescanRun"
         SET "status" = 'abandoned',
             "completedAt" = NOW(),
             "notes" = ${`chunk guard tripped at chunk ${CHUNK_INDEX} > limit ${MAX_CHUNKS}`}
       WHERE "generation" = ${GENERATION}
    `;
    await sendTelegram(
      `<b>ABANDONED</b> generation <b>${GENERATION}</b>: exceeded ${MAX_CHUNKS} chunks. Something is looping.`
    );
    process.exitCode = 1;
    return;
  }

  // --- Atomic Claim via FOR UPDATE SKIP LOCKED ---
  // Overlapping runners parallelize safely because claimed rows are locked/skipped.
  const claimed = await db<Array<{ address: string; memoryStatus: string | null }>>`
    WITH c AS (
      SELECT "address", "memoryStatus" FROM "WalletProfile"
       WHERE "profileGeneration" < ${GENERATION}
         AND "profileAttempts" < 3
         AND ("claimedAt" IS NULL OR "claimedAt" < NOW() - INTERVAL '30 minutes')
       ORDER BY "sourceRank" ASC NULLS LAST
       LIMIT ${CHUNK_SIZE}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE "WalletProfile" w
       SET "claimedAt" = NOW(), "claimedBy" = ${RUN_ID}
      FROM c WHERE w."address" = c."address"
    RETURNING w."address", c."memoryStatus"
  `;

  console.log(`generation ${GENERATION} chunk ${CHUNK_INDEX}: claimed ${claimed.length} wallets`);

  let done = 0;
  let failed = 0;
  let deadlineHit = false;

  for (const { address, memoryStatus } of claimed) {
    // Soft deadline check: release remaining claims so next chunk picks them up immediately
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      deadlineHit = true;
      await db`
        UPDATE "WalletProfile"
           SET "claimedAt" = NULL
         WHERE "claimedBy" = ${RUN_ID}
           AND "profileGeneration" < ${GENERATION}
      `;
      console.log('soft deadline reached (40m), released unprocessed claims');
      break;
    }

    try {
      await profileWallet(db, adapter, address);

      // Fetch the updated metrics for classification
      const [wp] = await db`SELECT * FROM "WalletProfile" WHERE "address" = ${address}`;
      if (wp) {
        const decision = classify(
          {
            address: wp.address,
            globalScore: Number(wp.globalScore ?? 0),
            tradeCount30d: Number(wp.tradeCount30d ?? 0),
            resolvedTradeCount30d: Number(wp.resolvedTradeCount30d ?? 0),
            realizedPnl30d: Number(wp.roi30d ?? 0), // ROI proxy
            consistency: Number(wp.consistencyScore ?? 0),
            maxDrawdown30d: 0.15, // fallback estimate if not present
            daysSinceLastTrade: 1,
            oneHitWonderFlag: Number(wp.oneHitWonderPenalty ?? 0) > 0.3,
            topTradePnlShare: Number(wp.oneHitWonderPenalty ?? 0),
          },
          (memoryStatus as any) ?? undefined
        );

        await db`
          UPDATE "WalletProfile"
             SET "profileGeneration" = ${GENERATION},
                 "lastProfiledAt"    = NOW(),
                 "profileError"      = NULL,
                 "profileAttempts"   = 0,
                 "claimedAt"         = NULL,
                 "claimedBy"         = NULL,
                 "memoryStatus"      = ${decision.status},
                 "memoryReason"      = ${decision.reason}
           WHERE "address" = ${address}
        `;
      }
      done++;
    } catch (e: unknown) {
      failed++;
      const errStr = redact(e).slice(0, 500);
      await db`
        UPDATE "WalletProfile"
           SET "profileAttempts" = "profileAttempts" + 1,
               "profileError"    = ${errStr},
               "claimedAt"       = NULL,
               "claimedBy"       = NULL
         WHERE "address" = ${address}
      `;
    }
  }

  // Record chunk progress in ledger
  await db`
    UPDATE "RescanRun"
       SET "doneWallets"   = "doneWallets" + ${done},
           "failedWallets" = "failedWallets" + ${failed},
           "chunkCount"    = ${CHUNK_INDEX}
     WHERE "generation" = ${GENERATION}
  `;

  // Query remaining wallets in generation
  const [{ remaining }] = await db<Array<{ remaining: number }>>`
    SELECT count(*)::int AS remaining FROM "WalletProfile"
     WHERE "profileGeneration" < ${GENERATION} AND "profileAttempts" < 3
  `;

  const chunkFailPct = claimed.length > 0 ? (failed / claimed.length) * 100 : 0;
  await heartbeat('rescan', chunkFailPct <= num('CHUNK_ABORT_FAILURE_PCT', 20), null, {
    generation: GENERATION,
    chunk: CHUNK_INDEX,
    done,
    failed,
    remaining,
    deadlineHit,
    durationMs: Date.now() - startedAt,
    limiters: allLimiterStats(),
  });

  // Termination Guard 2: remaining === 0
  if (remaining > 0) {
    // Self-chain: dispatch chunk N + 1
    try {
      await dispatchRescan(GENERATION, CHUNK_INDEX + 1);
      console.log(`chained chunk ${CHUNK_INDEX + 1}; ${remaining} wallets remaining`);
    } catch (e: unknown) {
      console.error(`dispatchRescan failed for chunk ${CHUNK_INDEX + 1}:`, redact(e));
    }
  } else {
    await finishGeneration(GENERATION);
  }

  if (chunkFailPct > num('CHUNK_ABORT_FAILURE_PCT', 20)) {
    throw new Error(`chunk failure rate ${chunkFailPct.toFixed(1)}% exceeds threshold (20%)`);
  }
}

async function finishGeneration(generation: number): Promise<void> {
  const db = getDb();
  const [run] = await db<Array<{ doneWallets: number; failedWallets: number; totalWallets: number }>>`
    SELECT "doneWallets", "failedWallets", "totalWallets" FROM "RescanRun" WHERE "generation" = ${generation}
  `;

  const failedAddrs = await db<Array<{ address: string }>>`
    SELECT "address" FROM "WalletProfile" WHERE "profileGeneration" < ${generation}
  `;

  const total = run?.totalWallets || 1;
  const failPct = (failedAddrs.length / total) * 100;
  const status = failPct > num('DEGRADED_FAILURE_PCT', 2) ? 'degraded' : 'complete';

  // Lazy import publisher if available, or publish inline
  let sha: string | null = null;
  try {
    const { publishMemory } = await import('../src/lib/memory/publish.ts');
    sha = await publishMemory({
      generation,
      status,
      failedAddresses: failedAddrs.map((f) => f.address),
    });
  } catch (e: unknown) {
    console.warn('publishMemory skipped or failed:', redact(e));
  }

  await db`
    UPDATE "RescanRun"
       SET "status" = ${status},
           "completedAt" = NOW(),
           "committedSha" = ${sha},
           "failedAddresses" = ${JSON.stringify(failedAddrs.map((f) => f.address))}::jsonb
     WHERE "generation" = ${generation}
  `;

  await sendTelegram(
    `<b>Generation ${generation} ${status.toUpperCase()}</b>\n` +
    `profiled ${run.doneWallets}/${run.totalWallets}, failed ${failedAddrs.length} (${failPct.toFixed(1)}%)\n` +
    `memory commit: ${sha ?? 'no change'}`
  );
}

try {
  await main();
} catch (e: unknown) {
  console.error('rescan-chunk failed:', redact(e));
  process.exitCode = 1;
} finally {
  const db = getDb();
  await db.end({ timeout: 5 });
}
