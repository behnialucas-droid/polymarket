/**
 * Rescan Helper — Foundation v2 Phase 4 §6.3 - §6.6
 *
 * Manages the 30-day wallet rescan generation lifecycle.
 *
 * Key rules:
 *   - Due-ness is anchored on completedAt (not startedAt).
 *   - Rescan dispatch uses WORKFLOW_DISPATCH_TOKEN.
 *   - No cron on rescan.yml — dispatch only.
 */

import { getDb } from './db.ts';
import { required, optional, redact } from './env.ts';

export interface DueResult {
  isDue: boolean;
  lastGeneration: number;
  lastCompletedAt: Date | null;
  daysRemaining: number;
  inProgress: boolean;
}

/**
 * Check whether a 30-day rescan generation is due.
 * Anchored on `completedAt`, NOT `startedAt`.
 */
export async function isRescanDue(intervalDays: number): Promise<DueResult> {
  const db = getDb();

  const [row] = await db<Array<{ lastGen: number; lastCompleted: Date | null; inProgress: boolean }>>`
    SELECT coalesce(max("generation"), 0)::int AS "lastGen",
           max("completedAt") FILTER (WHERE "status" IN ('complete','degraded')) AS "lastCompleted",
           coalesce(bool_or("status" = 'running'), false) AS "inProgress"
      FROM "RescanRun"
  `;

  const lastMs = row?.lastCompleted ? new Date(row.lastCompleted).getTime() : 0;
  const elapsedDays = lastMs > 0 ? (Date.now() - lastMs) / 86_400_000 : 999;
  const isDue = !row?.inProgress && elapsedDays >= intervalDays;

  return {
    isDue,
    lastGeneration: row?.lastGen ?? 0,
    lastCompletedAt: row?.lastCompleted ?? null,
    daysRemaining: Math.max(0, intervalDays - elapsedDays),
    inProgress: row?.inProgress ?? false,
  };
}

/**
 * Open a new rescan generation in the RescanRun ledger table.
 */
export async function openGeneration(generation: number): Promise<number> {
  const db = getDb();
  const [{ n }] = await db<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "WalletProfile"`;

  await db`
    INSERT INTO "RescanRun" ("generation", "status", "totalWallets")
    VALUES (${generation}, 'running', ${n})
    ON CONFLICT ("generation") DO NOTHING
  `;

  return generation;
}

/**
 * Trigger `rescan.yml` via GitHub REST API `workflow_dispatch`.
 * Requires WORKFLOW_DISPATCH_TOKEN.
 */
export async function dispatchRescan(generation: number, chunkIndex: number): Promise<void> {
  const token = required('WORKFLOW_DISPATCH_TOKEN');
  const repo  = optional('GITHUB_REPOSITORY', 'behnialucas-droid/polymarket') ?? 'behnialucas-droid/polymarket';
  const ref   = optional('GITHUB_DEFAULT_BRANCH', 'master') ?? 'master';

  const url = `https://api.github.com/repos/${repo}/actions/workflows/rescan.yml/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ref,
      inputs: {
        generation: String(generation),
        chunk_index: String(chunkIndex),
      },
    }),
  });

  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`dispatch failed: HTTP ${res.status} ${redact(text)}`);
  }
}
