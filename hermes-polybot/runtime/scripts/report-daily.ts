import { getDb } from '../src/lib/db.ts';
import { buildDailyReport, saveDailyReport, sendTelegram } from '../src/lib/engine/reports.ts';

const db = getDb();
try {
  const date = new Date().toISOString().slice(0, 10);
  const report = await buildDailyReport(db, date);
  let sent = false;
  try {
    sent = await sendTelegram(`Hermes Polybot daily report ${date}\n\n${report.summary}`);
  } catch (e: any) {
    console.error('TELEGRAM SEND FAILED:', e.message ?? e);
  }
  await saveDailyReport(db, report, sent, process.env.DATA_SOURCE === 'demo');
  console.log(`daily report saved for ${date} (telegram: ${sent ? 'sent' : 'not sent'})`);
} catch (e: any) {
  console.error('DAILY REPORT FAILED:', e.message ?? e);
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 }).catch(() => {});
}
