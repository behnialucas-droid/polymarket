/**
 * Memory Renderer — Foundation v2 Phase 5 §7.8
 *
 * Pure renderer: rows in → files out.
 * No I/O, no clock reads except the passed-in timestamp stamp.
 *
 * Enforces:
 *   - Total sort order everywhere (sourceRank, address, sorted JSON keys)
 *   - All floats formatted via .toFixed(4)
 *   - ZERO timestamps inside roster.csv or wallets/**
 *   - INDEX.md hard-capped at 150 lines IN CODE
 *   - LF line endings, trailing newline, lowercased addresses
 */

export interface MemoryFile {
  path: string;
  content: string;
}

export interface WalletRow {
  address: string;
  sourceRank: number;
  memoryStatus: 'copy' | 'watch' | 'ignore';
  globalScore: number;
  tradeCount30d: number;
  roi30d: number;
  winRate30d: number;
  consistencyScore: number;
  maxDrawdown30d: number;
  daysSinceLastTrade: number;
  firstSeenGeneration?: number;
  memoryReason: string;
}

export interface RenderInput {
  generation: number;
  status: 'complete' | 'degraded';
  completedAt: string; // ISO string passed in
  nextDueAt: string;
  ruleSetVersion: string;
  windowDays: number;
  failedAddresses: string[];
  wallets: WalletRow[];
  previous?: WalletRow[];
}

export function renderMemory(input: RenderInput): MemoryFile[] {
  const wallets = [...input.wallets].sort(
    (a, b) => a.sourceRank - b.sourceRank || a.address.localeCompare(b.address)
  );

  const files: MemoryFile[] = [];
  files.push({ path: 'memory/roster.csv', content: renderRoster(wallets) });
  files.push({ path: 'memory/generation.json', content: renderGeneration(input, wallets) });
  files.push({ path: 'memory/INDEX.md', content: renderIndex(input, wallets) });
  files.push({ path: 'memory/STATUS.md', content: renderStatus(input) });

  for (const w of wallets) {
    if (w.memoryStatus === 'ignore') continue; // 70% of bytes, 0% of value
    files.push({
      path: `memory/wallets/${w.memoryStatus}/${w.address.toLowerCase()}.md`,
      content: renderWalletDetail(w),
    });
  }

  if (input.previous && input.previous.length > 0) {
    const genStr = String(input.generation).padStart(4, '0');
    files.push({
      path: `memory/history/gen-${genStr}.md`,
      content: renderHistory(input.generation, input.previous, wallets),
    });
  }

  return files;
}

export function f4(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : '0.0000';
}

export function stableJson(obj: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
  );
  return JSON.stringify(sorted, null, 2) + '\n';
}

function renderRoster(wallets: WalletRow[]): string {
  const header =
    'rank,address,status,score,trades30d,pnl30d,winRate,consistency,maxDrawdown,daysSinceLastTrade,firstSeenGeneration,reason\n';
  const lines = wallets.map((w) => {
    const reasonEsc = '"' + (w.memoryReason ?? '').replace(/"/g, '""') + '"';
    return [
      w.sourceRank,
      w.address.toLowerCase(),
      w.memoryStatus,
      f4(w.globalScore),
      w.tradeCount30d,
      f4(w.roi30d),
      f4(w.winRate30d),
      f4(w.consistencyScore),
      f4(w.maxDrawdown30d),
      w.daysSinceLastTrade,
      w.firstSeenGeneration ?? 0,
      reasonEsc,
    ].join(',');
  });
  return header + lines.join('\n') + '\n';
}

function renderGeneration(input: RenderInput, wallets: WalletRow[]): string {
  const counts = {
    copy: wallets.filter((w) => w.memoryStatus === 'copy').length,
    watch: wallets.filter((w) => w.memoryStatus === 'watch').length,
    ignore: wallets.filter((w) => w.memoryStatus === 'ignore').length,
    total: wallets.length,
  };

  const obj = {
    completedAt: input.completedAt,
    counts,
    degradedReason: input.status === 'degraded' ? `${input.failedAddresses.length} failed` : null,
    failed: input.failedAddresses.length,
    failedAddresses: [...input.failedAddresses].sort(),
    generation: input.generation,
    nextDueAt: input.nextDueAt,
    profiled: wallets.length,
    ruleSetVersion: input.ruleSetVersion,
    status: input.status,
    windowDays: input.windowDays,
  };

  return stableJson(obj);
}

function renderIndex(input: RenderInput, wallets: WalletRow[]): string {
  const copyCount = wallets.filter((w) => w.memoryStatus === 'copy').length;
  const watchCount = wallets.filter((w) => w.memoryStatus === 'watch').length;
  const ignoreCount = wallets.filter((w) => w.memoryStatus === 'ignore').length;

  const top15 = wallets
    .filter((w) => w.memoryStatus === 'copy')
    .slice(0, 15);

  const lines: string[] = [
    `# Hermes Polybot — Memory Index`,
    ``,
    `Generation ${String(input.generation).padStart(4, '0')} · ${input.status} · ${wallets.length}/${wallets.length} profiled · ${input.failedAddresses.length} failed`,
    `Window: trailing ${input.windowDays} days · Rendered from Postgres, do not hand-edit.`,
    ``,
    `## What this is`,
    `Derived state. Postgres is the source of truth. Any manual edit here is`,
    `overwritten on the next publish and has no effect on the running system.`,
    ``,
    `## Roster summary`,
    `| status | count | meaning |`,
    `|---|---|---|`,
    `| copy   | ${String(copyCount).padStart(3)} | monitored every cycle; signals become paper positions |`,
    `| watch  | ${String(watchCount).padStart(3)} | monitored every cycle; signals recorded, not traded |`,
    `| ignore | ${String(ignoreCount).padStart(3)} | not monitored; re-evaluated next generation |`,
    ``,
    `## Top by score (copy tier)`,
    `| # | address | score | trades30d | pnl30d | consistency | since |`,
    `|---|---|---|---|---|---|---|`,
  ];

  for (let i = 0; i < top15.length; i++) {
    const w = top15[i];
    const addrShort = `${w.address.slice(0, 5)}...${w.address.slice(-4)}`;
    lines.push(
      `| ${i + 1} | ${addrShort} | ${f4(w.globalScore)} | ${w.tradeCount30d} | ${f4(w.roi30d)} | ${f4(w.consistencyScore)} | gen ${String(w.firstSeenGeneration ?? 0).padStart(4, '0')} |`
    );
  }

  lines.push(
    ``,
    `## Files`,
    `- \`roster.csv\` — every wallet, one row`,
    `- \`wallets/copy/\` — detail for copy tier`,
    `- \`wallets/watch/\` — detail for watch tier`,
    `- \`generation.json\` — machine-readable stamp`,
    `- \`STATUS.md\` — live health`,
    ``,
    `## For agents`,
    `Read this file first. Read \`roster.csv\` second if you need all 500.`,
    `Read individual wallet files only when asked about a specific address.`,
    `Never read all of \`wallets/\` at once.`
  );

  // HARD CAP ENFORCEMENT: Index must be <= 150 lines in code
  if (lines.length > 150) {
    lines.splice(140);
    lines.push(`\n*(truncated, see roster.csv)*`);
  }

  return lines.join('\n') + '\n';
}

function renderStatus(input: RenderInput): string {
  return [
    `# Hermes System Status`,
    ``,
    `Last Rescan Generation: ${input.generation}`,
    `Status: ${input.status}`,
    `Completed At: ${input.completedAt}`,
    `Next Due At: ${input.nextDueAt}`,
    `Rule Set Version: ${input.ruleSetVersion}`,
    `Failed Addresses: ${input.failedAddresses.length > 0 ? input.failedAddresses.join(', ') : 'none'}`,
    ``,
    `Postgres is the source of truth.`,
  ].join('\n') + '\n';
}

function renderWalletDetail(w: WalletRow): string {
  return [
    `# Wallet ${w.address.toLowerCase()}`,
    ``,
    `- **Status:** ${w.memoryStatus}`,
    `- **Rank:** ${w.sourceRank}`,
    `- **Global Score:** ${f4(w.globalScore)}`,
    `- **30d Trades:** ${w.tradeCount30d}`,
    `- **30d PnL / ROI:** ${f4(w.roi30d)}`,
    `- **Win Rate:** ${f4(w.winRate30d)}`,
    `- **Consistency:** ${f4(w.consistencyScore)}`,
    `- **Max Drawdown:** ${f4(w.maxDrawdown30d)}`,
    `- **Days Since Last Trade:** ${w.daysSinceLastTrade}`,
    `- **Reason:** ${w.memoryReason}`,
    ``,
    `*Derived state rendered from Postgres. Do not hand-edit.*`,
  ].join('\n') + '\n';
}

function renderHistory(
  generation: number,
  prevWallets: WalletRow[],
  currWallets: WalletRow[]
): string {
  const prevMap = new Map(prevWallets.map((w) => [w.address.toLowerCase(), w.memoryStatus]));
  const currMap = new Map(currWallets.map((w) => [w.address.toLowerCase(), w.memoryStatus]));

  const promoted: string[] = [];
  const demoted: string[] = [];

  for (const [addr, status] of currMap) {
    const prev = prevMap.get(addr);
    if (prev !== 'copy' && status === 'copy') promoted.push(addr);
    if (prev === 'copy' && status !== 'copy') demoted.push(addr);
  }

  return [
    `# Generation ${String(generation).padStart(4, '0')} History Diff`,
    ``,
    `## Promoted to copy (${promoted.length})`,
    ...promoted.map((a) => `- ${a}`),
    ``,
    `## Demoted from copy (${demoted.length})`,
    ...demoted.map((a) => `- ${a}`),
  ].join('\n') + '\n';
}
