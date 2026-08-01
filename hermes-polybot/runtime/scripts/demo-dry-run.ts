/** Offline demo dry-run: exercises the FULL decision chain with real logs and
 * zero infrastructure — no database, no network. Fixtures + DEMO_NOW_ISO make
 * every run reproducible. This is a verification harness, not the cycle: the
 * real cycle persists journals/ledger via PostgreSQL (see RUNBOOK-03).
 *
 *   source event -> decision evidence -> scoring -> risk admission
 *     -> signed request -> signed lot math -> (optional) settlement math
 *
 * Params below mirror the 007 migration seeds (cost-v1 / risk-v1) so the
 * dry-run admits exactly what the seeded live pipeline would admit.
 */
import { DemoAdapter, demoNow } from '../src/lib/adapters/demo.ts';
import { evaluateDecisionEvidence } from '../src/lib/engine/decisionEvidence.ts';
import { scoreTrade } from '../src/lib/engine/tradeScoring.ts';
import { DEFAULT_RULES } from '../src/lib/engine/rules.ts';
import { evaluateAdmission, type PortfolioState, type RiskLimits } from '../src/lib/engine/admission.ts';
import type { CostModelParams } from '../src/lib/engine/costModel.ts';
import { buildSignedRequest } from '../src/lib/engine/signedRequest.ts';
import { applySignedAction, type SignedLot } from '../src/lib/engine/signedPaperLedger.ts';
import { evaluateResolution, lotSettlementPnl, settlementPayout } from '../src/lib/engine/settlement.ts';
import { hoursToResolution } from '../src/lib/engine/horizon.ts';
import { toMicros } from '../src/lib/engine/decimal.ts';

// Mirrors 007_risk_admission.sql seeds. The real cycle loads these from the DB.
const COST_V1: CostModelParams = {
  version: 'cost-v1', feeBps: 20, halfSpreadFloorBps: 50, impactCoeff: 80,
  impactExponent: 0.5, latencyMs: 4000, latencyDriftBpsPerSec: 2, maxFillFraction: 0.05,
};
const RISK_V1: RiskLimits = {
  version: 'risk-v1',
  maxGrossExposureMicros: toMicros(400), maxNetExposureMicros: toMicros(300),
  maxPerInstrumentMicros: toMicros(40), maxPerWalletMicros: toMicros(120),
  maxPerCategoryMicros: toMicros(250), maxDailyTurnoverMicros: toMicros(300),
  maxConcurrentPositions: 25, maxQuoteAgeMs: 60_000, maxSpread: 0.08,
  minLiquidity: 1000, maxHorizonHours: 24, shortBufferPerShare: 0.02,
};
const STARTING_CASH_MICROS = toMicros(1000);

const WALLET_CONTEXT = {
  globalScore: 0.8, roi30d: 0.3, consistencyScore: 0.8, copyabilityScore: 0.8,
  bestCategory: 'crypto', categoryStrengths: { crypto: 0.9 },
};

const log = (stage: string, detail: unknown) =>
  console.log(`[${stage}]`, typeof detail === 'string' ? detail : JSON.stringify(detail));

const adapter = new DemoAdapter();
const now = demoNow();
log('clock', `demo decision clock ${now.toISOString()} (DEMO_NOW_ISO ${process.env.DEMO_NOW_ISO ?? 'unset -> wall clock'})`);

interface Book { marketId: string; outcome: string; lots: SignedLot[] }
const books = new Map<string, Book>();
let nextLotId = 1;
let reservedMicros = 0n;
let grossMicros = 0n;
let netMicros = 0n;
const perInstrument = new Map<string, bigint>();
const perWallet = new Map<string, bigint>();
const perCategory = new Map<string, bigint>();
let turnoverMicros = 0n;
const seenKeys = new Set<string>();
let admitted = 0;
let rejected = 0;

const leaderboard = await adapter.fetchLeaderboard(10);
log('leaderboard', `${leaderboard.length} demo wallets`);

for (const entry of leaderboard) {
  const sinceIso = new Date(now.getTime() - 30 * 864e5).toISOString();
  const trades = await adapter.fetchWalletTrades(entry.address, sinceIso);
  log('wallet', `${entry.address}: ${trades.length} observed source trades since ${sinceIso}`);

  for (const trade of trades) {
    const label = `${trade.providerEventId ?? trade.timestamp} ${trade.side} ${trade.outcome} @${trade.price} ${trade.marketId}`;
    let market;
    try {
      market = await adapter.fetchMarket(trade.marketId);
    } catch (e: any) {
      log('market', `${label} -> UNAVAILABLE (${e.message}); no decision, no guess`);
      continue;
    }

    // Decision evidence: the dry-run quote is collected at the demo clock itself.
    const evidence = evaluateDecisionEvidence(
      { id: 0, marketId: trade.marketId, quoteCollectedAt: now.toISOString() },
      trade.marketId,
      now,
    );
    if (evidence.status !== 'VALID') {
      log('evidence', `${label} -> ${evidence.status}: ${evidence.reason}`);
      continue;
    }

    const decision = scoreTrade(trade, market, WALLET_CONTEXT, DEFAULT_RULES, now.getTime());
    log('score', {
      trade: label, decision: decision.decision, copyScore: decision.copyScore,
      risks: decision.risks,
    });
    if (decision.decision !== 'paper_copy' || decision.simulatedPositionSize == null) continue;

    const direction = trade.side === 'BUY' ? 'LONG' : 'SHORT';
    const outcomeIsNo = trade.outcome?.toUpperCase() === 'NO';
    const legBid = outcomeIsNo ? (market.bestAsk != null ? 1 - market.bestAsk : NaN) : (market.bestBid ?? NaN);
    const legAsk = outcomeIsNo ? (market.bestBid != null ? 1 - market.bestBid : NaN) : (market.bestAsk ?? NaN);
    const instrumentKey = `${trade.conditionId}:${trade.assetId}:${trade.outcome}`;
    const admissionKey = `demo:${trade.providerEventId ?? trade.timestamp}:admission`;

    const portfolio: PortfolioState = {
      availableCollateralMicros: STARTING_CASH_MICROS - reservedMicros,
      grossExposureMicros: grossMicros,
      netExposureMicros: netMicros,
      instrumentExposureMicros: perInstrument.get(instrumentKey) ?? 0n,
      walletExposureMicros: perWallet.get(trade.walletAddress) ?? 0n,
      categoryExposureMicros: perCategory.get(trade.marketCategory ?? '') ?? 0n,
      dailyTurnoverMicros: turnoverMicros,
      openPositionCount: books.size,
      openedNewInstrument: !books.has(instrumentKey),
      duplicateIdempotencyKey: seenKeys.has(admissionKey),
    };
    const admission = evaluateAdmission(RISK_V1, COST_V1, {
      direction,
      requestedNotionalUsd: decision.simulatedPositionSize,
      quote: { bestBid: legBid, bestAsk: legAsk, liquidity: market.liquidity ?? NaN },
      quoteAgeMs: evidence.snapshotAgeMs ?? NaN,
      hoursToResolution: hoursToResolution(market, now.getTime()),
    }, portfolio);
    seenKeys.add(admissionKey);
    log('admission', {
      trade: label, admitted: admission.admitted,
      rejections: admission.rejections.map((r) => r.code),
      sizedShares: Number(admission.sizedShares.toFixed(6)),
      effectivePrice: Number(admission.cost.effectivePrice?.toFixed(6)),
      requiredCollateralUsd: Number((Number(admission.requiredCollateralMicros) / 1e6).toFixed(6)),
    });
    if (!admission.admitted) { rejected++; continue; }

    const book = books.get(instrumentKey) ?? { marketId: trade.marketId, outcome: trade.outcome ?? 'YES', lots: [] };
    const lots = book.lots;
    const hasSameDirectionExposure = lots.some((l) => l.direction === direction && l.remainingShares > 0);
    const request = buildSignedRequest({
      side: trade.side, paperAccountId: 1, observedTradeId: 0, decisionJournalId: 0,
      conditionId: trade.conditionId, assetId: trade.assetId, marketId: trade.marketId,
      outcome: trade.outcome, providerEventId: trade.providerEventId,
      hasSameDirectionExposure, admission, shortBufferPerShare: RISK_V1.shortBufferPerShare,
    });
    if (!request.ok) {
      log('signed-request', `${label} -> ${request.paperAction}: ${request.reason}`);
      rejected++;
      continue;
    }

    const result = applySignedAction(lots, request.request);
    if (result.openedShares > 0) {
      lots.push({
        id: nextLotId++, direction: result.direction, openedShares: result.openedShares,
        remainingShares: result.openedShares, entryPrice: request.request.executionPrice,
        entryFees: request.request.entryFees, collateral: result.entryCollateral,
      });
      books.set(instrumentKey, book);
      const delta = toMicros(result.entryCollateral);
      reservedMicros += delta;
      grossMicros += delta;
      netMicros += direction === 'LONG' ? delta : -delta;
      perInstrument.set(instrumentKey, (perInstrument.get(instrumentKey) ?? 0n) + delta);
      perWallet.set(trade.walletAddress, (perWallet.get(trade.walletAddress) ?? 0n) + delta);
      perCategory.set(trade.marketCategory ?? '', (perCategory.get(trade.marketCategory ?? '') ?? 0n) + delta);
      turnoverMicros += delta;
      admitted++;
    }
    log('signed-ledger', {
      action: result.action, opened: result.openedShares,
      entryCollateralUsd: Number(result.entryCollateral.toFixed(6)),
      independentInventory: `long+short lots for ${instrumentKey}: ${lots.filter((l) => l.remainingShares > 0).length}`,
    });
  }
}

// Settlement math over resolved fixture markets (confirmed evidence only).
// DEMO_SETTLE_NOW_ISO advances the demo clock for this pass only, so one
// process can show entry at T0 and settlement at T1 without persistence.
const settleClock = process.env.DEMO_SETTLE_NOW_ISO;
if (settleClock) {
  process.env.DEMO_NOW_ISO = settleClock;
  log('settlement', `advancing demo clock to ${demoNow().toISOString()} for the settlement pass`);
} else {
  log('settlement', 'checking open demo instruments at the entry clock (no DEMO_SETTLE_NOW_ISO)...');
}
for (const [instrumentKey, book] of books) {
  const open = book.lots.filter((l) => l.remainingShares > 0);
  if (!open.length) continue;
  let market;
  try {
    market = await adapter.fetchMarket(book.marketId);
  } catch (e: any) {
    log('settlement', `${instrumentKey}: market unavailable (${e.message}) -> stays awaiting settlement`);
    continue;
  }
  const evaluation = evaluateResolution(market);
  if (!evaluation) { log('settlement', `${instrumentKey}: unresolved -> stays awaiting settlement (never a default loss)`); continue; }
  if (evaluation.status !== 'confirmed') { log('settlement', `${instrumentKey}: only PROPOSED evidence (${evaluation.resolutionSource}) -> not finalized`); continue; }
  const payout = settlementPayout(evaluation.resolvedOutcome, book.outcome);
  const pnl = open.reduce((total, lot) => total + lotSettlementPnl(lot, payout), 0);
  log('settlement', { instrument: instrumentKey, confirmedOutcome: evaluation.resolvedOutcome, payout, settlementPnlUsd: Number(pnl.toFixed(6)) });
}

log('summary', {
  admitted, rejected,
  openInstruments: books.size,
  reservedCollateralUsd: Number((Number(reservedMicros) / 1e6).toFixed(6)),
  grossExposureUsd: Number((Number(grossMicros) / 1e6).toFixed(6)),
  netExposureUsd: Number((Number(netMicros) / 1e6).toFixed(6)),
  dailyTurnoverUsd: Number((Number(turnoverMicros) / 1e6).toFixed(6)),
});
log('note', 'dry-run only: nothing was persisted. Full cycle with PostgreSQL: RUNBOOK-03.');
