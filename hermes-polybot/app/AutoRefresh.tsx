'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

type Status = 'idle' | 'running' | 'ok' | 'error';

export default function AutoRefresh() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('idle');
  const [lastRun, setLastRun] = useState('');
  const [lastMsg, setLastMsg] = useState('');
  const [nextIn, setNextIn] = useState(INTERVAL_MS / 1000);

  // ─── Run one cycle ───────────────────────────────────────────────────────────
  async function runCycle() {
    // Fire the cycle (returns immediately — runs in background)
    const res = await fetch('/api/cycle', { method: 'POST' }).catch(() => null);
    if (!res) { setStatus('error'); setLastMsg('network error'); return; }
    const body = await res.json().catch(() => ({}));
    if (!body.ok && body.error !== 'cycle already running') {
      setStatus('error'); setLastMsg(body.error ?? 'error');
      return;
    }
    setStatus('running');
    setLastRun(new Date().toLocaleTimeString());

    // Poll every 5 s until done
    const poll = setInterval(async () => {
      const r = await fetch('/api/cycle').catch(() => null);
      if (!r) return;
      const d = await r.json().catch(() => ({}));
      if (!d.running) {
        clearInterval(poll);
        const ok = !String(d.lastResult ?? '').startsWith('ERROR');
        setStatus(ok ? 'ok' : 'error');
        setLastMsg(d.lastResult ?? '');
        router.refresh();
      }
    }, 5000);
  }

  // ─── Auto-trigger every 5 minutes ───────────────────────────────────────────
  useEffect(() => {
    // Run immediately on page load
    runCycle();

    // Countdown display
    let remaining = INTERVAL_MS / 1000;
    const countdown = setInterval(() => {
      remaining -= 1;
      setNextIn(remaining);
      if (remaining <= 0) {
        remaining = INTERVAL_MS / 1000;
        runCycle(); // auto-trigger
      }
    }, 1000);

    return () => clearInterval(countdown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Hydration Fix (Skip SSR) ────────────────────────────────────────────────
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  // ─── Badge colours ───────────────────────────────────────────────────────────
  const colour: Record<Status, string> = {
    idle: '#6b7280', running: '#f59e0b', ok: '#10b981', error: '#ef4444',
  };
  const mins = Math.floor(nextIn / 60);
  const secs = String(nextIn % 60).padStart(2, '0');

  return (
    <div style={{
      position: 'fixed', bottom: 16, right: 16, zIndex: 9999,
      background: '#111827', border: `1px solid ${colour[status]}55`,
      borderRadius: 12, padding: '8px 14px',
      display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 12, color: '#d1d5db',
      boxShadow: `0 0 16px ${colour[status]}22`,
    }}>
      {/* Pulse dot */}
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: colour[status], display: 'inline-block', flexShrink: 0,
        animation: status === 'running' ? 'hpulse 1s infinite' : 'none',
      }} />

      {/* Status text */}
      <span style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {status === 'running' && `⏳ Bot running… (started ${lastRun})`}
        {status === 'ok'      && `✓ ${lastRun} — ${lastMsg}`}
        {status === 'error'   && `✗ ${lastMsg}`}
        {status === 'idle'    && 'Hermes Bot — starting…'}
      </span>

      {/* Countdown */}
      {status !== 'running' && (
        <span style={{ color: '#6b7280', fontSize: 10, flexShrink: 0 }}>
          next {mins}:{secs}
        </span>
      )}

      {/* Manual trigger */}
      <button
        onClick={runCycle}
        style={{
          background: '#1f2937', border: '1px solid #374151',
          borderRadius: 6, padding: '2px 8px', color: '#9ca3af',
          cursor: 'pointer', fontSize: 11, flexShrink: 0,
        }}
      >▶ Run now</button>

      <style>{`@keyframes hpulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
    </div>
  );
}
