/**
 * Heartbeat — Foundation v2 Phase 3 §3.7
 *
 * Records the health of named jobs to the Heartbeat table.
 * The hourly watchdog reads these to detect silent failures like the
 * nine-hour crash window that went unnoticed in daemon.log.
 */

import { getDb } from './db.ts';
import { redact } from './env.ts';

export interface HeartbeatMeta {
  durationMs?: number;
  rescanNote?: string;
  generation?: number;
  chunk?: number;
  done?: number;
  failed?: number;
  remaining?: number;
  deadlineHit?: boolean;
  limiters?: unknown;
  [key: string]: unknown;
}

export interface HeartbeatRow {
  name: string;
  lastRunAt: Date;
  lastOkAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  metaJson: string | null;
}

/**
 * Upsert a heartbeat record for `name`.
 *
 * @param name   Logical name of the job (e.g. 'cycle', 'rescan', 'hourly')
 * @param ok     Whether this run succeeded
 * @param error  Error message if !ok (will be redacted)
 * @param meta   Arbitrary JSON payload for diagnostics
 */
export async function heartbeat(
  name: string,
  ok: boolean,
  error: string | null = null,
  meta: HeartbeatMeta = {}
): Promise<void> {
  const db = getDb();
  const now = new Date();

  try {
    await db`
      INSERT INTO "Heartbeat" (
        "name", "lastRunAt", "lastOkAt",
        "consecutiveFailures", "lastError", "metaJson", "updatedAt"
      ) VALUES (
        ${name},
        ${now},
        ${ok ? now : null},
        ${ok ? 0 : 1},
        ${error ? redact(error).slice(0, 1000) : null},
        ${JSON.stringify(meta)},
        ${now}
      )
      ON CONFLICT ("name") DO UPDATE SET
        "lastRunAt"           = EXCLUDED."lastRunAt",
        "lastOkAt"            = CASE WHEN ${ok} THEN EXCLUDED."lastOkAt" ELSE "Heartbeat"."lastOkAt" END,
        "consecutiveFailures" = CASE WHEN ${ok} THEN 0 ELSE "Heartbeat"."consecutiveFailures" + 1 END,
        "lastError"           = CASE WHEN ${ok} THEN NULL ELSE EXCLUDED."lastError" END,
        "metaJson"            = EXCLUDED."metaJson",
        "updatedAt"           = EXCLUDED."updatedAt"
    `;
  } catch (e: unknown) {
    // Heartbeat failure must never crash the caller
    console.error('heartbeat write failed:', redact(e));
  }
}

/**
 * Read all heartbeat rows (for the watchdog in report-hourly.ts).
 */
export async function readHeartbeats(): Promise<HeartbeatRow[]> {
  const db = getDb();
  return db<HeartbeatRow[]>`
    SELECT "name", "lastRunAt", "lastOkAt", "consecutiveFailures", "lastError", "metaJson"
    FROM "Heartbeat"
    ORDER BY "name"
  `;
}
