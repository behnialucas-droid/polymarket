import { rulesData } from '@/src/lib/queries.ts';




export const dynamic = 'force-dynamic';

export default async function Rules() {
  const { active, history, changes } = await rulesData();
  const rules = active ? JSON.parse(active.rulesJson) : null;
  return (
    <main className="space-y-4">
      <div className="panel p-4">
        <h2 className="mb-2 text-sm font-medium">Active rule set — version {active?.version ?? '—'}</h2>
        {rules ? (
          <pre className="overflow-x-auto rounded bg-[color:var(--bg)] p-3 text-xs">{JSON.stringify(rules, null, 2)}</pre>
        ) : <div className="text-sm text-[color:var(--muted)]">No rule set yet — run any scoring command to initialize.</div>}
      </div>
      <div className="panel overflow-x-auto p-4">
        <h2 className="mb-2 text-sm font-medium">Automatic rule changes (by Hermes)</h2>
        {changes.length === 0 && <div className="text-sm text-[color:var(--muted)]">No automatic changes yet.</div>}
        <table className="table-base">
          <thead><tr><th>When</th><th>Reason</th><th>Evidence</th><th>Before → After</th><th>Expected improvement</th></tr></thead>
          <tbody>
            {changes.map((c: any) => (
              <tr key={c.id}>
                <td>{c.createdAt?.slice(0, 16)}</td>
                <td className="max-w-64 whitespace-normal">{c.reason}</td>
                <td className="max-w-64 whitespace-normal text-[color:var(--muted)]">{c.evidenceSummary}</td>
                <td className="max-w-80 whitespace-normal text-xs">{diffRules(c.beforeJson, c.afterJson)}</td>
                <td className="max-w-48 whitespace-normal text-[color:var(--muted)]">{c.expectedImprovement}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel p-4">
        <h2 className="mb-2 text-sm font-medium">Version history</h2>
        <ul className="space-y-1 text-sm">
          {history.map((h: any) => (
            <li key={h.id}>v{h.version} — {h.createdAt} {h.active ? <span className="pill pill-track">active</span> : null}</li>
          ))}
        </ul>
      </div>
    </main>
  );
}

function diffRules(beforeJson?: string, afterJson?: string): string {
  try {
    const b = JSON.parse(beforeJson ?? '{}');
    const a = JSON.parse(afterJson ?? '{}');
    const out: string[] = [];
    for (const k of Object.keys(a)) {
      if (typeof a[k] === 'object') continue;
      if (b[k] !== a[k]) out.push(`${k}: ${b[k]} → ${a[k]}`);
    }
    return out.join(', ') || 'nested weight change';
  } catch { return '—'; }
}
