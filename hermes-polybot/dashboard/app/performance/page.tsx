import { performance as perf } from '@/src/lib/queries.ts';
import { computeBenchmarks } from '@/src/lib/engine/paperTrading.ts';
import { getDb } from '@/src/lib/db.ts';



import PnlChart from '../PnlChart.tsx';

export const dynamic = 'force-dynamic';

export default async function Performance() {
  const p = await perf();
  const b = await computeBenchmarks(getDb());
  return (
    <main className="space-y-4">
      <div className="panel p-4">
        <h2 className="mb-2 text-sm font-medium">Paper PnL over time (hourly)</h2>
        <PnlChart data={p.pnlSeries} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel p-4">
          <h2 className="mb-2 text-sm font-medium">Strategy benchmark (resolved data)</h2>
          <table className="table-base">
            <thead><tr><th>Strategy</th><th>Trades</th><th>PnL</th><th>Win rate</th></tr></thead>
            <tbody>
              <tr><td>Bot-filtered paper trades</td><td>{b.botFiltered.trades}</td><td>${b.botFiltered.pnl}</td><td>{(b.botFiltered.winRate * 100).toFixed(0)}%</td></tr>
              <tr><td>Blind leaderboard copy ($10 flat)</td><td>{b.blindCopy.trades}</td><td>${b.blindCopy.pnl}</td><td>{(b.blindCopy.winRate * 100).toFixed(0)}%</td></tr>
              <tr><td>Watchlist (hypothetical)</td><td>{b.watchlist.trades}</td><td>${b.watchlist.hypotheticalPnl}</td><td>—</td></tr>
              <tr><td>Skipped (hypothetical)</td><td>{b.skipped.trades}</td><td>${b.skipped.hypotheticalPnl}</td><td>—</td></tr>
            </tbody>
          </table>
          <div className="mt-2 text-sm text-[color:var(--muted)]">Missed winners: {b.missedWinners} · Avoided losers: {b.avoidedLosers}</div>
        </div>
        <div className="panel p-4">
          <h2 className="mb-2 text-sm font-medium">By category</h2>
          <table className="table-base">
            <thead><tr><th>Category</th><th>Trades</th><th>PnL</th></tr></thead>
            <tbody>{p.byCategory.map((c: any) => <tr key={c.cat}><td>{c.cat}</td><td>{c.n}</td><td className={c.pnl >= 0 ? 'text-[color:var(--green)]' : 'text-[color:var(--red)]'}>${c.pnl}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      <div className="panel overflow-x-auto p-4">
        <h2 className="mb-2 text-sm font-medium">By wallet</h2>
        <table className="table-base">
          <thead><tr><th>Wallet</th><th>Trades</th><th>PnL</th></tr></thead>
          <tbody>{p.byWallet.map((w: any) => <tr key={w.walletAddress}><td>{w.walletAddress.slice(0, 14)}…</td><td>{w.n}</td><td className={w.pnl >= 0 ? 'text-[color:var(--green)]' : 'text-[color:var(--red)]'}>${w.pnl}</td></tr>)}</tbody>
        </table>
      </div>
    </main>
  );
}
