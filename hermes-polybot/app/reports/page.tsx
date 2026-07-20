import { reportsData } from '../../src/lib/queries.ts';

export const dynamic = 'force-dynamic';

export default function Reports() {
  const rows = reportsData();
  return (
    <main className="space-y-4">
      {rows.length === 0 && <div className="panel p-6 text-sm text-[color:var(--muted)]">No reports yet — run npm run report:daily.</div>}
      {rows.map((r: any) => (
        <div key={r.id} className="panel p-4">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium">End-of-day report — {r.date}</h2>
            {r.isDemo ? <span className="pill pill-watch">DEMO DATA</span> : null}
            <span className={`pill ${r.sentToTelegram ? 'pill-track' : 'pill-resolved'}`}>{r.sentToTelegram ? 'sent to Telegram' : 'not sent'}</span>
          </div>
          <pre className="mt-2 whitespace-pre-wrap rounded bg-[color:var(--bg)] p-3 text-xs">{r.summary}</pre>
          <div className="mt-2 grid gap-4 text-xs text-[color:var(--muted)] md:grid-cols-2">
            <div>Best wallets: {fmtWallets(r.bestWalletsJson)}</div>
            <div>Worst wallets: {fmtWallets(r.worstWalletsJson)}</div>
          </div>
        </div>
      ))}
    </main>
  );
}

function fmtWallets(json?: string): string {
  try {
    const w = JSON.parse(json ?? '[]');
    return w.map((x: any) => `${String(x.walletAddress).slice(0, 12)}… ($${Number(x.pnl).toFixed(2)})`).join(', ') || '—';
  } catch { return '—'; }
}
