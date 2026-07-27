import Link from 'next/link';
import { paperTrades } from '@/src/lib/queries.ts';




export const dynamic = 'force-dynamic';

export default async function PaperTrades() {
  const rows = await paperTrades();
  return (
    <main className="panel overflow-x-auto p-4">
      <h2 className="mb-2 text-sm font-medium">Paper Trades ({rows.length}) — simulated only, $5–$20 each</h2>
      <table className="table-base">
        <thead><tr><th>Opened</th><th>Market</th><th>Wallet</th><th>Outcome</th><th>Size</th><th>Entry</th><th>Current</th><th>PnL</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          {rows.map((t: any) => {
            const pnl = t.realizedPnl ?? t.unrealizedPnl ?? 0;
            return (
              <tr key={t.id}>
                <td>{t.openedAt?.slice(5, 16)}</td>
                <td className="max-w-72 truncate">{t.marketQuestion ?? t.marketId}</td>
                <td><Link className="text-[color:var(--accent)]" href={`/wallets/${t.walletAddress}`}>{t.walletAddress.slice(0, 10)}…</Link></td>
                <td>{t.outcome}</td>
                <td>${t.simulatedPositionSize}</td>
                <td>{t.entryPrice}</td>
                <td>{t.currentPrice ?? '—'}</td>
                <td className={pnl >= 0 ? 'text-[color:var(--green)]' : 'text-[color:var(--red)]'}>${Number(pnl).toFixed(2)}</td>
                <td><span className={`pill pill-${t.status}`}>{t.status}</span></td>
                <td className="max-w-96 truncate text-[color:var(--muted)]">{t.reason}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
