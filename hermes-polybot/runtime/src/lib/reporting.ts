import type postgres from 'postgres';
import { redact } from './env.ts';

const STALE_RUN_MS = 20 * 60_000;

type ReportKind = 'hourly' | 'daily' | 'trial';

export interface ReportClaim {
  id: number;
  attempt: number;
}

/** Claims a report period. Completed sends are never resent; failed or abandoned
 * runs are safely reclaimed with a new recorded attempt. */
export async function claimReportRun(
  db: postgres.Sql,
  kind: ReportKind,
  periodKey: string,
): Promise<ReportClaim | null> {
  return db.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO "ReportRun" ("kind", "periodKey")
      VALUES (${kind}, ${periodKey})
      ON CONFLICT ("kind", "periodKey") DO UPDATE
      SET "status" = 'started', "startedAt" = CURRENT_TIMESTAMP, "finishedAt" = NULL
      WHERE "ReportRun"."status" = 'failed'
         OR ("ReportRun"."status" = 'started'
             AND "ReportRun"."startedAt" < CURRENT_TIMESTAMP - (${STALE_RUN_MS} * INTERVAL '1 millisecond'))
      RETURNING "id"
    `;
    if (!rows.length) return null;
    const id = Number(rows[0].id);
    const [attemptRow] = await tx`
      SELECT COALESCE(MAX("attempt"), 0)::int + 1 AS "attempt"
      FROM "ReportDelivery" WHERE "reportRunId" = ${id}
    `;
    return { id, attempt: Number(attemptRow.attempt) };
  });
}

export async function deliverClaimedReport(
  db: postgres.Sql,
  claim: ReportClaim,
  send: () => Promise<void>,
): Promise<void> {
  try {
    await send();
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO "ReportDelivery" ("reportRunId", "attempt", "status")
        VALUES (${claim.id}, ${claim.attempt}, 'sent')
      `;
      await tx`
        UPDATE "ReportRun" SET "status" = 'sent', "finishedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;
    });
  } catch (error: unknown) {
    const message = redact(error).slice(0, 500);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO "ReportDelivery" ("reportRunId", "attempt", "status", "error")
        VALUES (${claim.id}, ${claim.attempt}, 'failed', ${message})
      `;
      await tx`
        UPDATE "ReportRun" SET "status" = 'failed', "finishedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;
    }).catch(() => {});
    throw error;
  }
}
