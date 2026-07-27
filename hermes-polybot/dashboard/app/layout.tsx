import './globals.css';
import Link from 'next/link';
import AutoRefresh from './AutoRefresh.tsx';
import { hasDemoData } from '@/src/lib/queries.ts';




export const metadata = { title: 'Hermes Polybot — Paper Trading Research' };

const NAV = [
  ['/', 'Overview'],
  ['/wallets', 'Wallet Rankings'],
  ['/signals', 'Trade Signals'],
  ['/paper-trades', 'Paper Trades'],
  ['/journal', 'Decision Journal'],
  ['/performance', 'Performance'],
  ['/rules', 'Rules'],
  ['/reports', 'Reports'],
] as const;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let demo = false;
  try { demo = await hasDemoData(); } catch { /* db may not exist yet */ }
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen" suppressHydrationWarning>
        <AutoRefresh />
        <div className="mx-auto max-w-7xl px-4 py-4">
          <header className="mb-4 flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight">Hermes Polybot</h1>
            <span className="pill pill-open">PAPER TRADING ONLY</span>
            {demo && <span className="pill pill-watch">DEMO DATA</span>}
            <nav className="ml-auto flex flex-wrap gap-1 text-sm">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href} className="rounded px-2 py-1 text-[color:var(--muted)] hover:bg-[color:var(--panel)] hover:text-[color:var(--text)]">
                  {label}
                </Link>
              ))}
            </nav>
          </header>
          {children}
          <footer className="mt-8 text-xs text-[color:var(--muted)]">
            Research tool. Not financial advice. No real trades are placed; no keys are stored.
          </footer>
        </div>
      </body>
    </html>
  );
}
