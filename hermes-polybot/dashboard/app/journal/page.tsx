import { decisionJournal } from '@/src/lib/queries.ts';




export const dynamic = 'force-dynamic';

export default async function Journal() {
  const rows = await decisionJournal();
  return (
    <main className="panel overflow-x-auto p-4">
      <h2 className="mb-2 text-sm font-medium">Decision Journal ({rows.length} recent)</h2>
      <table className="table-base">
        <thead><tr><th>Time</th><th>Market</th><th>Decision</th><th>Score</th><th>Wallet</th><th>Consistency</th><th>Copyability</th><th>Timing</th><th>Spread</th><th>Liquidity</th><th>Thesis</th><th>Judged</th><th>Reasons / Risks</th></tr></thead>
        <tbody>
          {rows.map((d: any) => (
            <tr key={d.id}>
              <td>{d.createdAt?.slice(5, 16)}</td>
              <td className="max-w-64 truncate">{d.marketQuestion}</td>
              <td><span className={`pill pill-${d.decision}`}>{d.decision}</span></td>
              <td>{d.copyScore}</td>
              <td>{d.walletQualityScore?.toFixed?.(2) ?? d.walletQualityScore}</td>
              <td>{d.consistencyScore?.toFixed?.(2)}</td>
              <td>{d.copyabilityScore?.toFixed?.(2)}</td>
              <td>{d.entryTimingScore?.toFixed?.(2)}</td>
              <td>{d.spreadScore?.toFixed?.(2)}</td>
              <td>{d.liquidityScore?.toFixed?.(2)}</td>
              <td>{d.thesisScore?.toFixed?.(2)}</td>
              <td>{d.reviewOutcome ? <span className={`pill pill-${d.reviewOutcome}`}>{d.reviewOutcome}</span> : '—'}</td>
              <td className="max-w-96 truncate text-[color:var(--muted)]">
                {[...JSON.parse(d.reasonsJson ?? '[]'), ...JSON.parse(d.risksJson ?? '[]').map((r: string) => `⚠ ${r}`)].join('; ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
