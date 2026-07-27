/**
 * Telegram report builder — Foundation v2 §10.3
 *
 * Rules:
 *  - BAD NEWS FIRST. Always. If watchdog found problems, they are line 1.
 *  - Always produces formatted HTML output (parse_mode: 'HTML').
 *  - Escapes all dynamic inputs with esc().
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
  tradesLastHour: number;
  openPositions: number;
  openPnl: number;
  realized24h: number;
  generation: number;
}

export async function buildReport(ctx: ReportContext): Promise<string> {
  const db = getDb();

  let nowFormatted = new Date().toISOString();
  try {
    nowFormatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: ctx.tz,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date());
  } catch { /* keep ISO fallback */ }

  const [s] = await db<DBMetrics[]>`
    SELECT
      (SELECT count(*)::int FROM "WalletProfile" WHERE "memoryStatus" = 'copy' OR "status" = 'track')   AS "copyCount",
      (SELECT count(*)::int FROM "WalletProfile" WHERE "memoryStatus" = 'watch' OR "status" = 'watch')  AS "watchCount",
      (SELECT count(*)::int FROM "ObservedTrade" WHERE "createdAt" > NOW() - INTERVAL '1 hour')          AS "tradesLastHour",
      (SELECT count(*)::int FROM "PaperTrade" WHERE "status" = 'open')                                   AS "openPositions",
      (SELECT COALESCE(SUM("unrealizedPnl"), 0)::float FROM "PaperTrade" WHERE "status" = 'open')       AS "openPnl",
      (SELECT COALESCE(SUM("realizedPnl"), 0)::float   FROM "PaperTrade"
        WHERE "resolvedAt" > NOW() - INTERVAL '24 hours')                                                AS "realized24h",
      (SELECT COALESCE(MAX("generation"), 0)::int FROM "RescanRun"
        WHERE "status" IN ('complete','degraded'))                                                      AS "generation"
  `;

  const lines: string[] = [];

  // 1. BAD NEWS FIRST. Always.
  if (ctx.problems.length > 0) {
    lines.push('<b>🔴 DEGRADED</b>');
    for (const p of ctx.problems) {
      lines.push(`  • ${esc(p)}`);
    }
    lines.push('');
  }

  lines.push(`<b>Hermes</b> ${esc(nowFormatted)} (${esc(ctx.tz)})`);
  lines.push(`gen <b>${s.generation}</b> · copy <b>${s.copyCount}</b> · watch <b>${s.watchCount}</b>`);
  lines.push('');
  lines.push(`new trades (1h): <b>${s.tradesLastHour}</b>`);
  lines.push(`open positions: <b>${s.openPositions}</b>  (${fmtSigned(s.openPnl)})`);
  lines.push(`realized 24h: <b>${fmtSigned(s.realized24h)}</b>`);
  lines.push('');
  lines.push(`rules: <b>${esc(ctx.rules.version)}</b> · ${ctx.rules.triggered} triggered`);
  lines.push(`rescan: ${esc(ctx.rescanNote)}`);

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
