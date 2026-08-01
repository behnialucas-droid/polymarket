import { getDb } from '../src/lib/db.ts';
import { buildDailyReport, saveDailyReport } from '../src/lib/engine/reports.ts';
import { sendTelegram } from '../src/lib/telegram.ts';
import { claimReportRun, deliverClaimedReport } from '../src/lib/reporting.ts';
import { redact } from '../src/lib/env.ts';

const db = getDb();
try {
  const date = new Date().toISOString().slice(0, 10);
  const isDemo = process.env.DATA_SOURCE === 'demo';
  const report = await buildDailyReport(db, date);
  await saveDailyReport(db, report, false, isDemo);

  const claim = await claimReportRun(db, 'daily', date);
  if (!claim) {
    console.log(`daily report ${date} already sent or is actively sending — skipping duplicate send`);
  } else {
    await deliverClaimedReport(db, claim, () => sendTelegram(`Hermes Polybot daily report ${date}\n\n${report.summary}`));
    await saveDailyReport(db, report, true, isDemo);
    console.log(`daily report sent for ${date}`);
  }
} catch (e: unknown) {
  console.error('DAILY REPORT FAILED:', redact(e));
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 }).catch(() => {});
}
