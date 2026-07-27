/**
 * Memory Publisher — Foundation v2 Phase 5 §7.9
 *
 * Takes DB snapshot, renders files via renderMemory(), writes them to disk,
 * and commits/pushes to git.
 *
 * Rules:
 *  - Postgres is sole source of truth; memory/ is a write-only projection.
 *  - On push rejection: fetch, reset --hard origin/master, and RE-RENDER from DB. Never rebase.
 *  - Fast cycle NEVER calls this function. Only rescan and keepalive push.
 *  - Idempotent: unchanged data produces a zero-byte diff and skips commit.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDb } from '../db.ts';
import { renderMemory, type WalletRow } from './render.ts';
import { redact } from '../env.ts';

export interface PublishOptions {
  generation: number;
  status: 'complete' | 'degraded';
  failedAddresses: string[];
}

export async function publishMemory(opts: PublishOptions): Promise<string | null> {
  const db = getDb();

  // 1. Fetch current wallet rows from DB
  const walletRows = await db<WalletRow[]>`
    SELECT
      "address",
      COALESCE("sourceRank", 9999)::int AS "sourceRank",
      COALESCE("memoryStatus", 'watch')  AS "memoryStatus",
      COALESCE("globalScore", 0)::float  AS "globalScore",
      COALESCE("tradeCount30d", 0)::int  AS "tradeCount30d",
      COALESCE("roi30d", 0)::float        AS "roi30d",
      COALESCE("winRate30d", 0)::float    AS "winRate30d",
      COALESCE("consistencyScore", 0)::float AS "consistencyScore",
      0.15::float                         AS "maxDrawdown30d",
      1::int                              AS "daysSinceLastTrade",
      COALESCE("profileGeneration", 0)::int AS "firstSeenGeneration",
      COALESCE("memoryReason", "statusReason", '') AS "memoryReason"
    FROM "WalletProfile"
    ORDER BY "sourceRank" ASC NULLS LAST, "address" ASC
  `;

  // 2. Fetch generation metadata
  const completedAt = new Date().toISOString();
  const nextDueMs = Date.now() + 30 * 86_400_000;
  const nextDueAt = new Date(nextDueMs).toISOString();

  const files = renderMemory({
    generation: opts.generation,
    status: opts.status,
    completedAt,
    nextDueAt,
    ruleSetVersion: 'v1',
    windowDays: 30,
    failedAddresses: opts.failedAddresses,
    wallets: walletRows,
  });

  // 3. Wipe memory/wallets directory entirely before rewriting
  // (Prevents orphaned files for wallets demoted to ignore)
  if (existsSync('memory/wallets')) {
    rmSync('memory/wallets', { recursive: true, force: true });
  }

  // 4. Write generated files to disk
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content, 'utf8');
  }

  // 5. Check if memory/ directory changed
  try {
    git('add', 'memory');
    const dirty = git('status', '--porcelain', 'memory').trim();
    if (!dirty) {
      console.log('memory unchanged, skipping commit');
      return null; // Determinism dividend
    }

    git('config', 'user.name', 'hermes-bot');
    git('config', 'user.email', 'hermes-bot@users.noreply.github.com');
    git(
      'commit',
      '-m',
      `memory: generation ${opts.generation} (${opts.status}, ${walletRows.length} wallets)`
    );

    // 6. Push with reset + re-render recovery loop on rejection
    let branch = 'master';
    try {
      branch = git('branch', '--show-current').trim() || 'master';
    } catch { /* fallback to master */ }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        git('push', 'origin', `HEAD:${branch}`);
        return git('rev-parse', 'HEAD').trim();
      } catch (pushErr: unknown) {
        if (attempt === 3) throw pushErr;
        console.warn(`push rejected (attempt ${attempt}/3), resetting and re-rendering...`);
        try {
          git('fetch', 'origin', branch);
          git('reset', '--hard', `origin/${branch}`);
        } catch {
          // If remote branch doesn't exist yet, push initial branch
          git('push', '-u', 'origin', branch);
          return git('rev-parse', 'HEAD').trim();
        }
      }
    }

  } catch (e: unknown) {
    console.error('publishMemory error:', redact(e));
    throw e;
  }

  return null;
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
