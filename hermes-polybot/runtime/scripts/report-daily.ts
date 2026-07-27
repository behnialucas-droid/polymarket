import { getDb } from '../src/lib/db.ts';
import { buildDailyReport, saveDailyReport, sendTelegram } from '../src/lib/engine/reports.ts';

const db = getDb();
const date = new Date().toISOString().slice(0, 10);
const report = buildDailyReport(db, date);
let sent = false;
try {
  sent = await sendTelegram(`Hermes Polybot daily report ${date}\n\n${report.summary}`);
} catch (e: any) {
  console.error('TELEGRAM SEND FAILED:', e.message ?? e);
}
saveDailyReport(db, report, sent, process.env.DATA_SOURCE === 'demo');
console.log(`daily report saved for ${date} (telegram: ${sent ? 'sent' : 'not sent'})`);
