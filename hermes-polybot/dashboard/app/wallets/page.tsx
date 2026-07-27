import Link from 'next/link';
import { walletRankings } from '@/src/lib/queries.ts';




export const dynamic = 'force-dynamic';

export default async function Wallets() {
  const rows = await walletRankings();
  return (
    <main className="panel overflow-x-auto p-4">
      <h2 className="mb-2 text-sm font-medium">Wallet Rankings ({rows.length} scanned)</h2>
      <table className="table-base">
        <thead><tr><th>#</th><th>Wallet</th><th>Status</th><th>Global</th><th>ROI 30d</th><th>Consistency</th><th>Copyability</th><th>1-hit penalty</th><th>Best category</th><th>Reason</th></tr></thead>
        <tbody>
          {rows.map((w: any) => (
            <tr key={w.address}>
              <td>{w.sourceRank}</td>
              <td><Link className="text-[color:var(--accent)]" href={`/wallets/${w.address}`}>{w.label ?? `${w.address.slice(0, 10)}…`}</Link></td>
              <td><span className={`pill pill-${w.status}`}>{w.status}</span></td>
              <td>{w.globalScore ?? '—'}</td>
              <td>{w.roi30d != null ? `${(w.roi30d * 100).toFixed(1)}%` : '—'}</td>
              <td>{w.consistencyScore ?? '—'}</td>
              <td>{w.copyabilityScore ?? '—'}</td>
              <td>{w.oneHitWonderPenalty ?? '—'}</td>
              <td>{w.bestCategory ?? '—'}</td>
              <td className="max-w-96 truncate text-[color:var(--muted)]">{w.statusReason ?? 'not profiled yet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
