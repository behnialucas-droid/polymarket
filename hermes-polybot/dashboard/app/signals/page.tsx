import { tradeSignals } from '@/src/lib/queries.ts';




export const dynamic = 'force-dynamic';

export default async function Signals() {
  const rows = await tradeSignals();
  return (
    <main className="panel overflow-x-auto p-4">
      <h2 className="mb-2 text-sm font-medium">Trade Signals ({rows.length} recent)</h2>
      <table className="table-base">
        <thead><tr><th>Time</th><th>Market</th><th>Outcome</th><th>Entry</th><th>Detected</th><th>Move</th><th>Spread</th><th>Liquidity</th><th>TTR (h)</th><th>Decision</th><th>Score</th><th>Reason / Risk</th></tr></thead>
        <tbody>
          {rows.map((s: any) => {
            const move = s.detectedPrice != null && s.walletEntryPrice != null ? s.detectedPrice - s.walletEntryPrice : null;
            const reasons = JSON.parse(s.reasonsJson ?? '[]');
            const risks = JSON.parse(s.risksJson ?? '[]');
            return (
              <tr key={s.id}>
                <td>{s.timestamp?.slice(5, 16)}</td>
                <td className="max-w-72 truncate">{s.marketQuestion}</td>
                <td>{s.outcome}</td>
                <td>{s.walletEntryPrice}</td>
                <td>{s.detectedPrice ?? '—'}</td>
                <td className={move != null && move > 0 ? 'text-[color:var(--red)]' : 'text-[color:var(--green)]'}>{move != null ? move.toFixed(3) : '—'}</td>
                <td>{s.spread ?? '—'}</td>
                <td>{s.liquidity ?? '—'}</td>
                <td>{s.timeToResolution != null ? Math.round(s.timeToResolution) : '—'}</td>
                <td><span className={`pill pill-${s.decision}`}>{s.decision}</span></td>
                <td>{s.copyScore}</td>
                <td className="max-w-96 truncate text-[color:var(--muted)]">{[...reasons, ...risks.map((r: string) => `⚠ ${r}`)].join('; ')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
