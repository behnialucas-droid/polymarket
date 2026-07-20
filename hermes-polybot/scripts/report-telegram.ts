import { getDb } from '../src/lib/db.ts';
import { sendTelegram } from '../src/lib/telegram.ts';
import { writeFileSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

export async function runHourlyReport() {
  const db = getDb();
  
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  
  // 1. Wallets Scanned (overall vs tracked)
  const totalScanned = db.prepare('SELECT count(*) as c FROM WalletProfile').get() as { c: number };
  const trackedWallets = db.prepare("SELECT count(*) as c FROM WalletProfile WHERE status='track'").get() as { c: number };
  
  // 2-4. Copied, Ignored, Skipped (Overall)
  const decisions = db.prepare('SELECT decision, count(*) as c FROM DecisionJournal GROUP BY decision').all() as { decision: string, c: number }[];
  
  let copied = 0, ignored = 0, skipped = 0;
  for (const d of decisions) {
    if (d.decision === 'paper_copy') copied = d.c;
    if (d.decision === 'ignore') ignored = d.c;
    if (d.decision === 'skip') skipped = d.c;
  }
  
  // 5. Balance and Portfolio (Matching Web Dashboard exactly)
  const pnlObj = db.prepare('SELECT COALESCE(SUM(COALESCE(realizedPnl, unrealizedPnl, 0)),0) as pnl FROM PaperTrade').get() as { pnl: number };
  const openPositions = db.prepare("SELECT count(*) as c FROM PaperTrade WHERE status='open'").get() as { c: number };
  const resolved = db.prepare("SELECT count(*) as c, sum(case when realizedPnl > 0 then 1 else 0 end) as wins FROM PaperTrade WHERE status='resolved' AND realizedPnl IS NOT NULL").get() as { c: number, wins: number };
  
  const totalBalance = 10000 + pnlObj.pnl; // Assuming 10k starting balance
  const winRate = resolved.c > 0 ? ((resolved.wins / resolved.c) * 100).toFixed(0) + '%' : '—';
  
  const msg = `📊 <b>Hermes Portfolio Update</b>
  
<b>Wallet Pipeline (All-time)</b>
• Wallets Scanned: ${totalScanned.c}
• Actively Tracked: ${trackedWallets.c}
• Trades Copied: ${copied}
• Trades Ignored: ${ignored}
• Trades Skipped: ${skipped}

<b>Portfolio Status</b>
• Total Balance: $${totalBalance.toFixed(2)}
• Paper PnL: ${pnlObj.pnl >= 0 ? '+' : ''}$${pnlObj.pnl.toFixed(2)}
• Open Positions: ${openPositions.c}
• Win Rate: ${winRate}`;

  await sendTelegram(msg);

  // -- SMC-Style Database Backup to Git --
  // We dump the portfolio state to JSON, so it doesn't cause binary merge conflicts
  const openTrades = db.prepare(`SELECT * FROM PaperTrade WHERE status = 'open'`).all();
  const backupData = {
    timestamp: new Date().toISOString(),
    balance: totalBalance,
    openPositions: openPositions.c,
    realizedPnl: pnlObj.pnl || 0,
    openTrades
  };
  
  const backupFile = path.resolve(process.cwd(), 'portfolio-backup.json');
  const tmpFile = backupFile + '.tmp';
  
  try {
    writeFileSync(tmpFile, JSON.stringify(backupData, null, 2));
    renameSync(tmpFile, backupFile);
    
    // Git commit & push silently, only if we are in a git repository
    try {
      execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
      execSync('git add portfolio-backup.json', { stdio: 'ignore' });
      try {
        execSync('git commit -m "bot: portfolio backup"', { stdio: 'ignore' });
        execSync('git pull --rebase -X theirs origin master', { stdio: 'ignore' });
        execSync('git push origin master', { stdio: 'ignore' });
        console.log('GitHub backup pushed successfully.');
      } catch (e) {
        // Ignore if no changes to commit
      }
    } catch (e) {
      console.log('Not in a git repository or git not available, skipping cloud backup.');
    }
  } catch (err: any) {
    console.error('Backup failed:', err.message);
  }
}
