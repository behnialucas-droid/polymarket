'use client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

export default function PnlChart({ data }: { data: { hour: string; pnl: number }[] }) {
  if (!data.length) return <div className="p-6 text-sm text-[color:var(--muted)]">No PnL snapshots yet. Run npm run paper:update-pnl.</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
        <XAxis dataKey="hour" tick={{ fill: '#8b93a5', fontSize: 11 }} tickFormatter={(h: string) => h.slice(5)} />
        <YAxis tick={{ fill: '#8b93a5', fontSize: 11 }} width={48} />
        <Tooltip contentStyle={{ background: '#12161f', border: '1px solid #1f2633', borderRadius: 8, color: '#e6e9f0' }} />
        <ReferenceLine y={0} stroke="#1f2633" />
        <Line type="monotone" dataKey="pnl" stroke="#4f8cff" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
