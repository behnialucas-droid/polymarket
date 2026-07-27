import { walletProfile } from '@/src/lib/queries.ts';




export const dynamic = 'force-dynamic';

export default async function WalletDetail({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const { profile: p, recentTrades, paperPerf } = await walletProfile(address);
  if (!p) return <main className="panel p-6">Wallet not found.</main>;
  const cats = JSON.parse(p.categoryStrengthsJson ?? '{}');
  return (
    <main className="space-y-4">
      <div className="panel p-4">
        <h2 className="text-sm font-medium">{p.label ?? p.address}</h2>
        <div className="mt-1 text-xs text-[color:var(--muted)]">{p.address}</div>
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 text-sm md:grid-cols-4">
          <div>Status: <span className={`pill pill-${p.status}`}>{p.status}</span></div>
          <div>ROI 30d: {p.roi30d != null ? `${(p.roi30d * 100).toFixed(1)}%` : '—'}</div>
          <div>Trades 30d: {p.tradeCount30d ?? '—'} ({p.resolvedTradeCount30d ?? 0} resolved)</div>
          <div>Win rate: {p.winRate30d != null ? `${(p.winRate30d * 100).toFixed(0)}%` : '—'}</div>
          <div>Avg trade size: ${p.averageTradeSize ?? '—'}</div>
          <div>Avg liquidity: {p.averageLiquidity ?? '—'}</div>
          <div>Avg spread: {p.averageSpread ?? '—'}</div>
          <div>Avg entry timing: {p.averageEntryTiming != null ? `${p.averageEntryTiming}h before resolution` : '—'}</div>
        </div>
        <div className="mt-2 text-sm">Copyability: {p.copyabilityScore ?? '—'} — <span className="text-[color:var(--muted)]">{p.copyabilityNotes}</span></div>
        {p.riskNotes && <div className="text-sm text-[color:var(--red)]">Risk: {p.riskNotes}</div>}
        <div className="mt-2 text-sm">Category strengths: {Object.entries(cats).map(([c, v]) => `${c}: ${v}`).join(' · ') || '—'}</div>
        <div className="mt-2 text-sm">Paper performance if copied: {paperPerf?.n ?? 0} trades, ${paperPerf?.pnl ?? 0} PnL</div>
      </div>
      <div className="panel overflow-x-auto p-4">
        <h3 className="mb-2 text-sm font-medium">Recent trades</h3>
        <table className="table-base">
          <thead><tr><th>Time</th><th>Market</th><th>Outcome</th><th>Side</th><th>Entry</th><th>Size</th></tr></thead>
          <tbody>
            {recentTrades.map((t: any) => (
              <tr key={t.id}><td>{t.timestamp?.slice(0, 16)}</td><td className="max-w-80 truncate">{t.marketQuestion}</td><td>{t.outcome}</td><td>{t.side}</td><td>{t.walletEntryPrice}</td><td>${t.size}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
