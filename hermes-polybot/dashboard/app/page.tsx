import { overview } from '@/src/lib/queries.ts';



import PnlChart from './PnlChart.tsx';

export const dynamic = 'force-dynamic';

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'green' | 'red' }) {
  return (
    <div className="panel p-4">
      <div className="text-xs text-[color:var(--muted)]">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone === 'green' ? 'text-[color:var(--green)]' : tone === 'red' ? 'text-[color:var(--red)]' : ''}`}>{value}</div>
    </div>
  );
}

export default async function Overview() {
  const o = await overview();
  const winRate = o.resolved.length ? o.resolved.filter((r: any) => r.realizedPnl > 0).length / o.resolved.length : null;
  return (
    <main className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total paper PnL" value={`$${Number(o.totalPnl).toFixed(2)}`} tone={o.totalPnl >= 0 ? 'green' : 'red'} />
        <Stat label="Win rate (resolved)" value={winRate === null ? '—' : `${(winRate * 100).toFixed(0)}%`} />
        <Stat label="Open paper positions" value={o.openPositions} />
        <Stat label="Tracked wallets" value={o.trackedWallets} />
        <Stat label="Copy candidates today" value={o.copyToday} />
        <Stat label="Last daily report" value={o.lastReport ? o.lastReport.date : 'none'} />
      </div>
      <div className="panel p-4">
        <h2 className="mb-2 text-sm font-medium">Paper PnL over time</h2>
        <PnlChart data={o.pnlSeries} />
      </div>
      <div className="panel p-4">
        <h2 className="mb-2 text-sm font-medium">Latest rule changes</h2>
        {o.ruleChanges.length === 0 && <div className="text-sm text-[color:var(--muted)]">No rule changes yet.</div>}
        <ul className="space-y-1 text-sm">
          {o.ruleChanges.map((r: any, i: number) => (
            <li key={i}><span className="text-[color:var(--muted)]">{r.createdAt}</span> — {r.reason}</li>
          ))}
        </ul>
      </div>
    </main>
  );
}
