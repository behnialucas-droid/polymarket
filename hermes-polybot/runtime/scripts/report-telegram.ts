import { getDb } from '../src/lib/db.ts';
import { sendTelegram } from '../src/lib/telegram.ts';

export async function runHourlyReport() {
  const db = getDb();
  
  // 1. Wallets Scanned (overall vs tracked)
  const [totalScannedRes, trackedWalletsRes] = await Promise.all([
    db`SELECT count(*) as c FROM "WalletProfile"`,
    db`SELECT count(*) as c FROM "WalletProfile" WHERE "status"='track'`
  ]);
  
  const totalScanned = totalScannedRes[0];
  const trackedWallets = trackedWalletsRes[0];
  
  // 2-4. Copied, Ignored, Skipped (Overall)
  const decisions = await db`SELECT "decision", count(*) as c FROM "DecisionJournal" GROUP BY "decision"`;
  
  let copied = 0, watched = 0, skipped = 0;
  for (const d of decisions) {
    if (d.decision === 'paper_copy') copied = Number(d.c);
    if (d.decision === 'watchlist') watched = Number(d.c);
    if (d.decision === 'skip') skipped = Number(d.c);
  }
  
  // 5. Balance and Portfolio (Matching Web Dashboard exactly)
  const [pnlObjRes, openPositionsRes, resolvedRes] = await Promise.all([
    db`SELECT COALESCE(SUM(COALESCE("realizedPnl", "unrealizedPnl", 0)),0) as pnl FROM "PaperTrade"`,
    db`SELECT count(*) as c FROM "PaperTrade" WHERE "status"='open'`,
    db`SELECT count(*) as c, sum(case when "realizedPnl" > 0 then 1 else 0 end) as wins FROM "PaperTrade" WHERE "status"='resolved' AND "realizedPnl" IS NOT NULL`
  ]);
  
  const pnlObj = { pnl: Number(pnlObjRes[0]?.pnl ?? 0) };
  const openPositions = { c: Number(openPositionsRes[0]?.c ?? 0) };
  const resolved = { 
    c: Number(resolvedRes[0]?.c ?? 0), 
    wins: Number(resolvedRes[0]?.wins ?? 0) 
  };
  
  const totalBalance = 10000 + pnlObj.pnl; // Assuming 10k starting balance
  const winRate = resolved.c > 0 ? ((resolved.wins / resolved.c) * 100).toFixed(0) + '%' : '—';
  
  const msg = `📊 <b>Hermes Portfolio Update</b>
  
<b>Wallet Pipeline (All-time)</b>
• Wallets Scanned: ${totalScanned.c}
• Tracked Wallets: ${trackedWallets.c}
• Trades Copied: ${copied}
• Trades Watched: ${watched}
• Trades Skipped: ${skipped}

<b>Portfolio Status</b>
• Total Balance: $${totalBalance.toFixed(2)}
• Paper PnL: ${pnlObj.pnl >= 0 ? '+' : ''}$${pnlObj.pnl.toFixed(2)}
• Open Positions: ${openPositions.c}
• Win Rate: ${winRate}`;

  await sendTelegram(msg);

  // Note: SMC-style git commits have been removed in favor of Supabase cloud state.
}
