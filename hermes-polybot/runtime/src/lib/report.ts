/**
 * Telegram report builder — Foundation v2 §10.3
 *
 * Rules:
 *  - BAD NEWS FIRST. Always. If watchdog found problems, they are line 1.
 *  - Always produces formatted HTML output (parse_mode: 'HTML').
 *  - Escapes all dynamic inputs with esc().
 *  - Each problem is capped at 150 chars (single line) to prevent cascade-nesting.
 */

import { getDb } from './db.ts';
import { esc } from './telegram.ts';

export interface RulesSummary {
  version: string;
  triggered: number;
}

export interface ReportContext {
  rules: RulesSummary;
  problems: string[];
  rescanNote: string;
  tz: string;
}

interface DBMetrics {
  copyCount: number;
  watchCount: number;
  tradesNew15m: number;
  tradesNew1h: number;
  openPositions: number;
  openPnl: number;
  realized24h: number;
  generation: number;
  lastCycleOkAt: Date | null;
}

export async function buildReport(ctx: ReportContext): Promise<string> {
  const db = getDb();

  // Format current time in configured timezone
  let nowFormatted = new Date().toISOString();
  try {
    nowFormatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: ctx.tz,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
  } catch { /* keep ISO fallback */ }

  const [s] = await db<DBMetrics[]>`
    SELECT
      (SELECT count(*)::int FROM "WalletProfile" WHERE "memoryStatus" = 'copy' OR "status" = 'track')   AS "copyCount",
      (SELECT count(*)::int FROM "WalletProfile" WHERE "memoryStatus" = 'watch' OR "status" = 'watch')  AS "watchCount",
      (SELECT count(*)::int FROM "ObservedTrade" WHERE "createdAt" > NOW() - INTERVAL '15 minutes')      AS "tradesNew15m",
      (SELECT count(*)::int FROM "ObservedTrade" WHERE "createdAt" > NOW() - INTERVAL '1 hour')          AS "tradesNew1h",
      (SELECT count(*)::int FROM "PaperTrade" WHERE "status" = 'open')                                   AS "openPositions",
      (SELECT COALESCE(SUM("unrealizedPnl"), 0)::float FROM "PaperTrade" WHERE "status" = 'open')       AS "openPnl",
      (SELECT COALESCE(SUM("realizedPnl"), 0)::float   FROM "PaperTrade"
        WHERE "resolvedAt" > NOW() - INTERVAL '24 hours')                                                AS "realized24h",
      (SELECT COALESCE(MAX("generation"), 0)::int FROM "RescanRun"
        WHERE "status" IN ('complete','degraded'))                                                      AS "generation",
      (SELECT "lastOkAt" FROM "Heartbeat" WHERE "name" = 'cycle' LIMIT 1)                              AS "lastCycleOkAt"
  `;

  // Format last-cycle-ok age
  let cycleAge = 'unknown';
  if (s?.lastCycleOkAt) {
    const ageMin = Math.round((Date.now() - new Date(s.lastCycleOkAt).getTime()) / 60_000);
    if (ageMin < 60) {
      cycleAge = `${ageMin}m ago`;
    } else {
      cycleAge = `${Math.round(ageMin / 60)}h ago`;
    }
  }

  const lines: string[] = [];

  // 1. BAD NEWS FIRST. Always. Truncate each problem to 150 chars (single line) to prevent
  //    cascade-nesting from ballooning the message across multiple runs.
  if (ctx.problems.length > 0) {
    lines.push('<b>🔴 DEGRADED</b>');
    for (const p of ctx.problems) {
      const firstLine = p.split('\n')[0].trim().slice(0, 150);
      lines.push(`  • ${esc(firstLine)}`);
    }
    lines.push('');
  }

  lines.push(`<b>Hermes</b> ${esc(nowFormatted)} (${esc(ctx.tz)})`);
  lines.push(`gen <b>${s?.generation ?? 0}</b> · copy <b>${s?.copyCount ?? 0}</b> · watch <b>${s?.watchCount ?? 0}</b>`);
  lines.push('');
  lines.push(`new trades (15m): <b>${s?.tradesNew15m ?? 0}</b> · (1h: <b>${s?.tradesNew1h ?? 0}</b>)`);
  lines.push(`open positions: <b>${s?.openPositions ?? 0}</b>  (${fmtSigned(s?.openPnl ?? 0)})`);
  lines.push(`realized 24h: <b>${fmtSigned(s?.realized24h ?? 0)}</b>`);
  lines.push('');
  lines.push(`rules: <b>${esc(ctx.rules.version)}</b> · ${ctx.rules.triggered} triggered`);
  lines.push(`rescan: ${esc(ctx.rescanNote)}`);
  lines.push(`cycle last ok: ${cycleAge}`);

  if (ctx.problems.length === 0) {
    lines.push('');
    lines.push('🟢 all systems nominal');
  }

  return lines.join('\n');
}

function fmtSigned(n: number): string {
  const v = Number(n ?? 0);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}
