/** Pipeline steps shared by scripts. Fail loud: adapter errors propagate. */
import type postgres from 'postgres';
import { getAdapter, type DataAdapter } from '../src/lib/adapters/index.ts';
import { scoreWallet, walletStatus, type TradeWithMarket } from '../src/lib/engine/walletScoring.ts';
import { scoreTrade } from '../src/lib/engine/tradeScoring.ts';
import { getActiveRules } from '../src/lib/engine/rules.ts';
import { evaluateDecisionEvidence, type DecisionSnapshotEvidence } from '../src/lib/engine/decisionEvidence.ts';
import { evaluateAdmission } from '../src/lib/engine/admission.ts';
import { loadActiveCostModelParams, loadActiveRiskLimits, loadPortfolioState, recordAdmissionCheck } from '../src/lib/engine/admissionDb.ts';
import { buildSignedRequest } from '../src/lib/engine/signedRequest.ts';
import { applySignedPaperLedgerActionInTransaction, getSignedPaperAccount } from '../src/lib/engine/signedPaperLedgerDb.ts';
import { hoursToResolution } from '../src/lib/engine/horizon.ts';
import type { MarketData } from '../src/lib/adapters/types.ts';
import { num } from '../src/lib/env.ts';

function marketFromSnapshot(snapshot: any): MarketData {
  const raw = typeof snapshot.rawMarketJson === 'string' ? JSON.parse(snapshot.rawMarketJson) : {};
  return {
    marketId: snapshot.marketId,
    conditionId: snapshot.conditionId ?? undefined,
    question: snapshot.question ?? undefined,
    category: snapshot.category ?? undefined,
    yesPrice: snapshot.yesPrice == null ? undefined : Number(snapshot.yesPrice),
    noPrice: snapshot.noPrice == null ? undefined : Number(snapshot.noPrice),
    bestBid: snapshot.bestBid == null ? undefined : Number(snapshot.bestBid),
    bestAsk: snapshot.bestAsk == null ? undefined : Number(snapshot.bestAsk),
    spread: snapshot.spread == null ? undefined : Number(snapshot.spread),
    liquidity: snapshot.liquidity == null ? undefined : Number(snapshot.liquidity),
    volume: snapshot.volume == null ? undefined : Number(snapshot.volume),
    endDateIso: snapshot.endDate ?? raw.endDateIso ?? undefined,
    timeToResolutionHours: snapshot.timeToResolution == null ? undefined : Number(snapshot.timeToResolution),
    slug: raw.slug ?? undefined,
    resolved: raw.resolved === true,
    resolvedOutcome: raw.resolvedOutcome ?? undefined,
    raw,
  };
}

export function since30d(): string {
  return new Date(Date.now() - 30 * 864e5).toISOString();
}

export async function runLeaderboardScan(db: postgres.Sql, adapter: DataAdapter, limit = 500): Promise<number> {
  const entries = await adapter.fetchLeaderboard(limit);
  await db`
    INSERT INTO "LeaderboardScan" ("source", "scannedAt", "walletCount", "lookbackDays", "rawSummaryJson", "isDemo") 
    VALUES (${adapter.source}, CURRENT_TIMESTAMP, ${entries.length}, 30, ${JSON.stringify(entries.slice(0, 50))}, ${adapter.isDemo ? 1 : 0})
  `;
  const CHUNK_SIZE = 50;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const rows = chunk.map(e => ({
      address: e.address,
      label: e.label ?? null,
      sourceRank: e.rank,
      isDemo: adapter.isDemo ? 1 : 0
    }));
    await db`
      INSERT INTO "WalletProfile" ${db(rows, 'address', 'label', 'sourceRank', 'isDemo')}
      ON CONFLICT("address") DO UPDATE SET "label"=EXCLUDED."label", "sourceRank"=EXCLUDED."sourceRank", "updatedAt"=CURRENT_TIMESTAMP
    `;
  }
  return entries.length;
}

export async function profileWallet(db: postgres.Sql, adapter: DataAdapter, address: string): Promise<void> {
  const trades = await adapter.fetchWalletTrades(address, since30d());
  const uniqueMarketIds = Array.from(new Set(trades.map((t) => t.marketId).filter(Boolean)));
  const marketCache = new Map<string, any>();

  const BATCH_SIZE = 20;
  for (let i = 0; i < uniqueMarketIds.length; i += BATCH_SIZE) {
    const batch = uniqueMarketIds.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (mId) => {
        try {
          const m = await adapter.fetchMarket(mId);
          marketCache.set(mId, m);
        } catch {
          // Market archived or missing
        }
      })
    );
  }

  const items: TradeWithMarket[] = [];
  for (const t of trades) {
    if (!t.marketId) continue;
    const m = marketCache.get(t.marketId);
    if (!m) continue;
    let pnlPerDollar: number | undefined;
    if (m.resolved && m.resolvedOutcome && t.price > 0) {
      const won = String(m.resolvedOutcome).toUpperCase() === String(t.outcome).toUpperCase();
      pnlPerDollar = ((won ? 1 : 0) - t.price) / t.price;
    } else if (t.price > 0) {
      const currentPrice = t.outcome?.toUpperCase() === 'NO' ? (m.noPrice ?? (m.yesPrice ? 1 - m.yesPrice : undefined)) : m.yesPrice;
      if (currentPrice !== undefined && currentPrice > 0) {
        pnlPerDollar = (currentPrice - t.price) / t.price;
      }
    }
    items.push({ trade: t, market: m, pnlPerDollar });
  }
  const { rules } = await getActiveRules(db);
  const s = scoreWallet(items, rules.maxTimeToResolutionHours);
  const st = walletStatus(s, rules.minWalletGlobalScore, rules.minShortTermShare);

  await db`
    UPDATE "WalletProfile" SET 
      "status"=${st.status}, "statusReason"=${st.reason}, "roi30d"=${s.roi30d}, "consistencyScore"=${s.consistencyScore}, 
      "copyabilityScore"=${s.copyabilityScore}, "oneHitWonderPenalty"=${s.oneHitWonderPenalty}, "globalScore"=${s.globalScore},
      "bestCategory"=${s.bestCategory}, "categoryStrengthsJson"=${JSON.stringify(s.categoryStrengths)}, "averageTradeSize"=${s.averageTradeSize}, 
      "tradeCount30d"=${s.tradeCount30d}, "resolvedTradeCount30d"=${s.resolvedTradeCount30d}, "winRate30d"=${s.winRate30d},
      "averageLiquidity"=${s.averageLiquidity}, "averageSpread"=${s.averageSpread}, "averageEntryTiming"=${s.averageEntryTiming},
      "shortTermShare"=${s.shortTermShare},
      "copyabilityNotes"=${s.copyabilityNotes}, "riskNotes"=${s.riskNotes}, "lastScannedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
    WHERE "address"=${address}
  `;
}

/** Detect trades from ALL tracked wallets; store them + market snapshots concurrently. */
export async function monitorTrades(db: postgres.Sql, adapter: DataAdapter): Promise<number> {
  const { createHash } = await import('node:crypto');
  const scanLimit = Number(process.env.WALLET_SCAN_LIMIT ?? 500);
  const tracked = await db`
    SELECT "address" FROM "WalletProfile"
    WHERE "memoryStatus" IN ('copy','watch') OR "status" IN ('track','watch','copy')
    ORDER BY "lastScannedAt" ASC NULLS FIRST
    LIMIT ${scanLimit}
  `;
  if (tracked.length === 0) return 0;

  // Pre-calculate HWM timestamps for all tracked wallets in a single query
  const addresses = tracked.map((w) => w.address);
  const hwmRows = await db`
    SELECT "walletAddress", MAX("timestamp") AS "maxTs"
    FROM "ObservedTrade"
    WHERE "walletAddress" = ANY(${addresses})
    GROUP BY "walletAddress"
  `;
  const hwmMap = new Map<string, string>();
  for (const r of hwmRows) {
    if (r.maxTs) hwmMap.set(r.walletAddress, r.maxTs);
  }

  let newCount = 0;
  const CONCURRENCY = 15; // Concurrent wallet fetch batch size

  for (let i = 0; i < tracked.length; i += CONCURRENCY) {
    const chunk = tracked.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (w) => {
        const maxTs = hwmMap.get(w.address);
        let since: string;
        if (maxTs) {
          const maxMs = new Date(maxTs).getTime();
          since = new Date(maxMs - 15 * 60_000).toISOString(); // 15-min overlap
        } else {
          since = since30d(); // fallback for newly-tracked wallet
        }

        let trades: any[];
        try {
          trades = await adapter.fetchWalletTrades(w.address, since);
        } catch {
          return;
        }

        for (const t of trades) {
          if (!t.marketId) continue;

          const rawStr = t.providerEventId
            ? `polymarket|${t.providerEventId}`
            : `${t.walletAddress}|${t.marketId}|${t.outcome ?? ''}|${t.side}|${t.timestamp}|${t.quantityShares ?? ''}|${t.notionalUsd ?? ''}|${t.assetId ?? ''}`;
          const tradeHash = createHash('sha256').update(rawStr).digest('hex');

          let m: any;
          try {
            m = await adapter.fetchMarket(t.marketId);
          } catch {
            continue;
          }
          const detectedPrice = t.outcome?.toUpperCase() === 'NO' ? m.noPrice : m.yesPrice;
          const quoteCollectedAt = new Date().toISOString();

          try {
            const inserted = await db.begin(async (tx) => {
              const observed = await tx`
                INSERT INTO "ObservedTrade" (
                  "walletAddress", "marketId", "conditionId", "marketQuestion", "marketCategory",
                  "outcome", "side", "walletEntryPrice", "detectedPrice", "size", "quantityShares", "notionalUsd",
                  "source", "providerEventId", "transactionHash", "assetId", "outcomeIndex", "observedAt", "timestamp",
                  "rawTradeJson", "isDemo", "tradeHash"
                )
                VALUES (
                  ${t.walletAddress}, ${t.marketId}, ${t.conditionId ?? null}, ${t.marketQuestion ?? null},
                  ${t.marketCategory ?? null}, ${t.outcome ?? null}, ${t.side}, ${t.price},
                  ${detectedPrice ?? null}, ${t.size}, ${t.quantityShares ?? null}, ${t.notionalUsd ?? t.size},
                  'polymarket', ${t.providerEventId ?? null}, ${t.transactionHash ?? null}, ${t.assetId ?? null}, ${t.outcomeIndex ?? null}, ${t.observedAt ?? new Date().toISOString()}, ${t.timestamp},
                  ${JSON.stringify(t.raw ?? null)}, ${adapter.isDemo ? 1 : 0}, ${tradeHash}
                )
                ON CONFLICT ("tradeHash") DO NOTHING
                RETURNING "id"
              `;
              if (observed.length === 0) return false;

              await tx`
                INSERT INTO "MarketSnapshot" (
                  "marketId", "conditionId", "question", "category", "yesPrice", "noPrice",
                  "bestBid", "bestAsk", "spread", "liquidity", "volume", "timeToResolution", "endDate",
                  "collectedAt", "quoteCollectedAt", "rawMarketJson", "isDemo"
                )
                VALUES (
                  ${m.marketId}, ${m.conditionId ?? null}, ${m.question ?? null}, ${m.category ?? null},
                  ${m.yesPrice ?? null}, ${m.noPrice ?? null}, ${m.bestBid ?? null}, ${m.bestAsk ?? null},
                  ${m.spread ?? null}, ${m.liquidity ?? null}, ${m.volume ?? null},
                  ${m.timeToResolutionHours ?? null}, ${m.endDateIso ?? null}, ${quoteCollectedAt}, ${quoteCollectedAt},
                  ${JSON.stringify({ ...m, raw: undefined, resolvedOutcome: m.resolvedOutcome })},
                  ${adapter.isDemo ? 1 : 0}
                )
              `;
              return true;
            });
            if (inserted) newCount++;
          } catch {
            // Duplicate conflicts are idempotent; transaction failures leave no partial evidence.
          }
        }

        try {
          await db`UPDATE "WalletProfile" SET "lastScannedAt" = CURRENT_TIMESTAMP WHERE "address" = ${w.address}`;
        } catch { /* ignore update lock contention */ }
      })
    );
  }

  return newCount;
}

/** Score unscored trades from immutable market evidence; never refetch current market state.
 * An admitted paper_copy flows into the signed v2 ledger inside the SAME transaction as
 * its journal and admission evidence. Legacy long-only PaperTrade/PaperLedger is frozen
 * history and is no longer written by this pipeline. */
export async function scoreNewTrades(db: postgres.Sql, adapter: DataAdapter): Promise<{ scored: number; copied: number }> {
  const { rules } = await getActiveRules(db);
  const riskLimits = await loadActiveRiskLimits(db);
  const costParams = await loadActiveCostModelParams(db);
  const signedAccountId = await getSignedPaperAccount(db, adapter.isDemo);
  const batchSize = Math.max(1, Math.min(10000, num('TRADE_SCORE_BATCH_SIZE', 500)));
  const unscored = await db`
    SELECT ot.* FROM "ObservedTrade" ot
    WHERE NOT EXISTS (SELECT 1 FROM "DecisionJournal" dj WHERE dj."observedTradeId" = ot."id")
    ORDER BY ot."id" ASC
    LIMIT ${batchSize}
  `;
  let copied = 0;
  for (const ot of unscored) {
    const wpList = await db`SELECT * FROM "WalletProfile" WHERE "address" = ${ot.walletAddress}`;
    const wp = wpList[0];

    const trade = {
      walletAddress: ot.walletAddress, marketId: ot.marketId, conditionId: ot.conditionId,
      marketQuestion: ot.marketQuestion, marketCategory: ot.marketCategory, outcome: ot.outcome,
      side: ot.side as 'BUY' | 'SELL', price: Number(ot.walletEntryPrice), size: Number(ot.notionalUsd ?? ot.size),
      quantityShares: ot.quantityShares == null ? undefined : Number(ot.quantityShares),
      notionalUsd: ot.notionalUsd == null ? undefined : Number(ot.notionalUsd),
      providerEventId: ot.providerEventId ?? undefined, transactionHash: ot.transactionHash ?? undefined,
      assetId: ot.assetId ?? undefined, outcomeIndex: ot.outcomeIndex == null ? undefined : Number(ot.outcomeIndex),
      observedAt: ot.observedAt ?? undefined, timestamp: ot.timestamp,
    };
    const wallet = wp && wp.globalScore != null ? {
      globalScore: Number(wp.globalScore), roi30d: Number(wp.roi30d ?? 0), consistencyScore: Number(wp.consistencyScore ?? 0),
      copyabilityScore: Number(wp.copyabilityScore ?? 0), bestCategory: wp.bestCategory,
      categoryStrengths: JSON.parse(wp.categoryStrengthsJson ?? '{}'),
    } : null;

    const journal = await db.begin(async (tx) => {
      const decisionAt = new Date();
      const snapshots = await tx`
        SELECT * FROM "MarketSnapshot"
        WHERE "marketId" = ${ot.marketId}
        ORDER BY ("quoteCollectedAt" <= ${decisionAt.toISOString()}) DESC NULLS LAST,
                 "quoteCollectedAt" DESC NULLS LAST, "id" DESC
        LIMIT 1
        FOR UPDATE
      `;
      const snapshot = snapshots[0] ?? null;
      const evidence = evaluateDecisionEvidence(
        snapshot as DecisionSnapshotEvidence | null,
        ot.marketId,
        decisionAt,
      );

      if (evidence.status !== 'VALID') {
        const res = await tx`
          INSERT INTO "DecisionJournal" (
            "observedTradeId", "walletAddress", "marketId", "decision", "reasonsJson", "risksJson", "isDemo",
            "marketSnapshotId", "decisionAt", "evidenceVersion", "evidenceStatus", "quoteCollectedAt", "snapshotAgeMs", "maxSnapshotAgeMs"
          ) VALUES (
            ${ot.id}, ${ot.walletAddress}, ${ot.marketId}, 'skip', ${JSON.stringify([])}, ${JSON.stringify([evidence.reason])}, ${adapter.isDemo ? 1 : 0},
            ${evidence.marketSnapshotId}, ${evidence.decisionAt}, 1, ${evidence.status}, ${evidence.quoteCollectedAt}, ${evidence.snapshotAgeMs}, ${evidence.maxSnapshotAgeMs}
          ) RETURNING "id"
        `;
        return { decision: 'skip' as const, journalId: Number(res[0].id), opened: false };
      }

      if (!wallet) {
        const reason = 'wallet profile is missing or has no global score at decision time';
        const res = await tx`
          INSERT INTO "DecisionJournal" (
            "observedTradeId", "walletAddress", "marketId", "decision", "reasonsJson", "risksJson", "isDemo",
            "marketSnapshotId", "decisionAt", "evidenceVersion", "evidenceStatus", "quoteCollectedAt", "snapshotAgeMs", "maxSnapshotAgeMs"
          ) VALUES (
            ${ot.id}, ${ot.walletAddress}, ${ot.marketId}, 'skip', ${JSON.stringify([])}, ${JSON.stringify([reason])}, ${adapter.isDemo ? 1 : 0},
            ${evidence.marketSnapshotId}, ${evidence.decisionAt}, 1, ${evidence.status}, ${evidence.quoteCollectedAt}, ${evidence.snapshotAgeMs}, ${evidence.maxSnapshotAgeMs}
          ) RETURNING "id"
        `;
        return { decision: 'skip' as const, journalId: Number(res[0].id), opened: false };
      }

      const market = marketFromSnapshot(snapshot);
      const d = scoreTrade(trade, market, wallet, rules, decisionAt.getTime());
      const res = await tx`
        INSERT INTO "DecisionJournal" ("observedTradeId", "walletAddress", "marketId", "decision", "copyScore", "confidence", "reasonsJson", "risksJson",
           "walletQualityScore", "roiScore", "consistencyScore", "copyabilityScore", "categoryFitScore", "entryTimingScore", "spreadScore", "liquidityScore", "thesisScore", "horizonScore", "simulatedPositionSize", "isDemo",
           "marketSnapshotId", "decisionAt", "evidenceVersion", "evidenceStatus", "quoteCollectedAt", "snapshotAgeMs", "maxSnapshotAgeMs")
        VALUES (${ot.id}, ${ot.walletAddress}, ${ot.marketId}, ${d.decision}, ${d.copyScore}, ${d.confidence}, ${JSON.stringify(d.reasons)}, ${JSON.stringify(d.risks)},
        ${d.scores.walletQualityScore}, ${d.scores.roiScore}, ${d.scores.consistencyScore}, ${d.scores.copyabilityScore}, ${d.scores.categoryFitScore},
        ${d.scores.entryTimingScore}, ${d.scores.spreadScore}, ${d.scores.liquidityScore}, ${d.scores.thesisScore}, ${d.scores.horizonScore}, ${d.simulatedPositionSize}, ${adapter.isDemo ? 1 : 0},
        ${evidence.marketSnapshotId}, ${evidence.decisionAt}, 1, ${evidence.status}, ${evidence.quoteCollectedAt}, ${evidence.snapshotAgeMs}, ${evidence.maxSnapshotAgeMs})
        RETURNING "id"
      `;
      const journalId = Number(res[0].id);
      if (d.decision !== 'paper_copy') {
        return { decision: d.decision, journalId, opened: false };
      }

      // Risk admission + signed ledger, same transaction as the journal.
      const requestedNotional = d.simulatedPositionSize;
      if (requestedNotional == null || requestedNotional < 5 || requestedNotional > 20) {
        await tx`UPDATE "DecisionJournal" SET "paperAction" = 'REJECTED_NOT_ADMITTED', "paperActionReason" = 'Hermes notional outside the $5-$20 policy band' WHERE "id" = ${journalId}`;
        return { decision: d.decision, journalId, opened: false };
      }
      const side = trade.side;
      const direction = side === 'BUY' ? 'LONG' : 'SHORT';
      const admissionKey = `polymarket:${trade.providerEventId ?? `observed:${ot.id}`}:admission:v2`;
      // The signed book keys instruments by (conditionId, assetId, outcome); the
      // quote leg is the observed outcome side of the book.
      const outcomeIsNo = trade.outcome?.toUpperCase() === 'NO';
      const legBid = outcomeIsNo
        ? (market.bestAsk != null ? 1 - market.bestAsk : undefined)
        : market.bestBid;
      const legAsk = outcomeIsNo
        ? (market.bestBid != null ? 1 - market.bestBid : undefined)
        : market.bestAsk;
      const portfolio = await loadPortfolioState(tx, {
        paperAccountId: signedAccountId,
        conditionId: trade.conditionId ?? null,
        assetId: trade.assetId ?? null,
        outcome: trade.outcome ?? null,
        walletAddress: trade.walletAddress,
        category: trade.marketCategory ?? null,
        idempotencyKey: admissionKey,
      });
      const admission = evaluateAdmission(riskLimits, costParams, {
        direction,
        requestedNotionalUsd: requestedNotional,
        quote: {
          bestBid: legBid ?? Number.NaN,
          bestAsk: legAsk ?? Number.NaN,
          liquidity: market.liquidity ?? Number.NaN,
        },
        quoteAgeMs: evidence.snapshotAgeMs ?? Number.NaN,
        hoursToResolution: hoursToResolution(market, decisionAt.getTime()),
      }, portfolio);
      await recordAdmissionCheck(tx, {
        paperAccountId: signedAccountId,
        decisionJournalId: journalId,
        observedTradeId: Number(ot.id),
        idempotencyKey: admissionKey,
      }, admission, costParams.version);

      const samePosition = await tx`
        SELECT p."longShares", p."shortShares"
        FROM "SignedPaperPosition" p
        JOIN "PaperInstrument" i ON i."id" = p."paperInstrumentId"
        WHERE p."paperAccountId" = ${signedAccountId}
          AND i."conditionId" = ${trade.conditionId ?? null}
          AND i."assetId" = ${trade.assetId ?? null}
          AND i."outcome" = ${trade.outcome ?? null}
      `;
      const hasSameDirectionExposure = samePosition.length > 0 && (
        direction === 'LONG'
          ? Number(samePosition[0].longShares) > 0
          : Number(samePosition[0].shortShares) > 0
      );
      const signedRequest = buildSignedRequest({
        side,
        paperAccountId: signedAccountId,
        observedTradeId: Number(ot.id),
        decisionJournalId: journalId,
        conditionId: trade.conditionId,
        assetId: trade.assetId,
        marketId: trade.marketId,
        outcome: trade.outcome,
        providerEventId: trade.providerEventId,
        hasSameDirectionExposure,
        admission,
        shortBufferPerShare: riskLimits.shortBufferPerShare,
      });
      if (!signedRequest.ok) {
        await tx`UPDATE "DecisionJournal" SET "paperAction" = ${signedRequest.paperAction}, "paperActionReason" = ${signedRequest.reason} WHERE "id" = ${journalId}`;
        return { decision: d.decision, journalId, opened: false };
      }
      const ledgerResult = await applySignedPaperLedgerActionInTransaction(tx, signedRequest.request);
      await tx`UPDATE "DecisionJournal" SET "paperAction" = ${signedRequest.request.action}, "paperPositionId" = ${ledgerResult.positionId} WHERE "id" = ${journalId}`;
      return { decision: d.decision, journalId, opened: !ledgerResult.duplicate };
    });

    if (journal.opened) copied++;
  }
  return { scored: unscored.length, copied };
}

export { getAdapter };
