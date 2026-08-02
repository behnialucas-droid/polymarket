/**
 * Rebuild the copy-wallet universe under a NEW short-term scoring epoch.
 *
 * Creates an INACTIVE ScoringEpoch, rescores wallets using confirmed short-term
 * resolutions only (shortTermWalletScoring.ts), stamps each profile with the
 * epoch id, and ranks the top WALLET_UNIVERSE_SIZE (default 500) qualifiers.
 * Nothing changes for the live pipeline until activate-scoring-epoch.ts flips
 * the active pointer — legacy scores stay in place for audit.
 *
 * Fail-closed: a wallet below SHORT_TERM_MIN_TRADES gets copyScore NULL and can
 * never rank. If fewer than the target qualify, the shortfall is reported, never
 * padded with unproven wallets.
 */
import { getDb } from '../src/lib/db.ts';
import { getAdapter } from '../src/lib/adapters/index.ts';
import type { TradeWithMarket } from '../src/lib/engine/walletScoring.ts';
import {
  scoreShortTermWallet,
  selectTopWallets,
  DEFAULT_SHORT_TERM_SCORE_CONFIG,
} from '../src/lib/engine/shortTermWalletScoring.ts';
import { num } from '../src/lib/env.ts';
import { since30d } from './pipeline.ts';

const db = getDb();
const adapter = getAdapter();

const config = {
  maxHours: num('SHORT_TERM_MAX_HOURS', DEFAULT_SHORT_TERM_SCORE_CONFIG.maxHours),
  minTrades: num('SHORT_TERM_MIN_TRADES', DEFAULT_SHORT_TERM_SCORE_CONFIG.minTrades),
  recencyHalfLifeDays: num('SHORT_TERM_RECENCY_HALF_LIFE_DAYS', DEFAULT_SHORT_TERM_SCORE_CONFIG.recencyHalfLifeDays),
};
const universeSize = Math.max(1, num('WALLET_UNIVERSE_SIZE', 500));
const rescoreLimit = Math.max(1, num('WALLET_RESCORE_LIMIT', 1000));

try {
  const epochRows = await db`
    INSERT INTO "ScoringEpoch" ("criteriaJson", "notes", "active")
    VALUES (${JSON.stringify({ kind: 'short-term-only', ...config, universeSize })},
            ${'short-term rebuild via rescore-wallets-shortterm.ts'}, FALSE)
    RETURNING "id"
  `;
  const epochId = Number(epochRows[0].id);
  console.log(`created candidate ScoringEpoch ${epochId} (inactive) — criteria: <=${config.maxHours}h, min ${config.minTrades} resolved trades, half-life ${config.recencyHalfLifeDays}d`);

  const wallets = await db`
    SELECT "address" FROM "WalletProfile"
    WHERE "isDemo" = ${adapter.isDemo ? 1 : 0}
    ORDER BY "sourceRank" ASC NULLS LAST, "address" ASC
    LIMIT ${rescoreLimit}
  `;
  console.log(`rescoring ${wallets.length} wallets (${adapter.source}${adapter.isDemo ? ' DEMO' : ''})`);

  const scoringTimeMs = Date.now();
  const qualified: Array<{ address: string; shortTermCopyScore: number }> = [];
  let scored = 0;
  let invalid = 0;
  let failed = 0;

  for (const w of wallets) {
    let items: TradeWithMarket[];
    try {
      const trades = await adapter.fetchWalletTrades(w.address, since30d());
      const marketIds = Array.from(new Set(trades.map((t) => t.marketId).filter(Boolean)));
      const markets = new Map<string, any>();
      const BATCH = 20;
      for (let i = 0; i < marketIds.length; i += BATCH) {
        await Promise.all(marketIds.slice(i, i + BATCH).map(async (mId) => {
          try { markets.set(mId, await adapter.fetchMarket(mId)); } catch { /* archived */ }
        }));
      }
      items = [];
      for (const t of trades) {
        const m = t.marketId ? markets.get(t.marketId) : undefined;
        if (!m) continue;
        let pnlPerDollar: number | undefined;
        if (m.resolved && m.resolvedOutcome && t.price > 0) {
          const won = String(m.resolvedOutcome).toUpperCase() === String(t.outcome).toUpperCase();
          pnlPerDollar = ((won ? 1 : 0) - t.price) / t.price;
        }
        items.push({ trade: t, market: m, pnlPerDollar });
      }
    } catch (e: any) {
      failed++;
      console.error(`rescore fetch failed for ${w.address}: ${e?.message ?? e}`);
      continue;
    }

    const s = scoreShortTermWallet(items, scoringTimeMs, config);
    await db`
      UPDATE "WalletProfile" SET
        "scoringEpoch" = ${epochId},
        "shortTermTradeCount" = ${s.shortTermTradeCount},
        "shortTermWinRate" = ${s.shortTermWinRate},
        "shortTermPnlPerDollar" = ${s.shortTermPnlPerDollar},
        "shortTermRecencyWeight" = ${s.shortTermRecencyWeight},
        "shortTermCopyScore" = ${s.shortTermCopyScore},
        "shortTermRank" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "address" = ${w.address}
    `;
    scored++;
    if (s.valid && s.shortTermCopyScore != null) {
      qualified.push({ address: w.address, shortTermCopyScore: s.shortTermCopyScore });
    } else {
      invalid++;
    }
    if (scored % 50 === 0) console.log(`  progress: ${scored}/${wallets.length} scored`);
  }

  const top = selectTopWallets(qualified, universeSize);
  for (let i = 0; i < top.length; i++) {
    await db`
      UPDATE "WalletProfile" SET "shortTermRank" = ${i + 1}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "address" = ${top[i].address} AND "scoringEpoch" = ${epochId}
    `;
  }

  console.log(`epoch ${epochId} summary:`);
  console.log(`  wallets scored:      ${scored}`);
  console.log(`  qualified (valid):   ${qualified.length}`);
  console.log(`  below min sample:    ${invalid}`);
  console.log(`  fetch failures:      ${failed}`);
  console.log(`  ranked universe:     ${top.length} of target ${universeSize}${top.length < universeSize ? ' — SHORTFALL: insufficient resolved short-term history; do not pad' : ''}`);
  console.log(`next step: EPOCH_ID=${epochId} EPOCH_CONFIRM=yes node --experimental-strip-types scripts/activate-scoring-epoch.ts`);
} finally {
  await db.end({ timeout: 5 }).catch(() => {});
}
