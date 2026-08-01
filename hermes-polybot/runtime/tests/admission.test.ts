import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAdmission, type RiskLimits, type PortfolioState, type AdmissionCandidate } from '../src/lib/engine/admission.ts';
import { toMicros } from '../src/lib/engine/decimal.ts';
import type { CostModelParams } from '../src/lib/engine/costModel.ts';

const limits: RiskLimits = {
  version: 'risk-test',
  maxGrossExposureMicros: toMicros(400),
  maxNetExposureMicros: toMicros(300),
  maxPerInstrumentMicros: toMicros(40),
  maxPerWalletMicros: toMicros(120),
  maxPerCategoryMicros: toMicros(250),
  maxDailyTurnoverMicros: toMicros(300),
  maxConcurrentPositions: 25,
  maxQuoteAgeMs: 60_000,
  maxSpread: 0.08,
  minLiquidity: 1000,
  maxHorizonHours: 24,
  shortBufferPerShare: 0.02,
};
const costParams: CostModelParams = {
  version: 'cost-test', feeBps: 20, halfSpreadFloorBps: 50, impactCoeff: 80,
  impactExponent: 0.5, latencyMs: 4000, latencyDriftBpsPerSec: 2, maxFillFraction: 0.05,
};
const emptyPortfolio: PortfolioState = {
  availableCollateralMicros: toMicros(1000),
  grossExposureMicros: 0n,
  netExposureMicros: 0n,
  instrumentExposureMicros: 0n,
  walletExposureMicros: 0n,
  categoryExposureMicros: 0n,
  dailyTurnoverMicros: 0n,
  openPositionCount: 0,
  openedNewInstrument: true,
  duplicateIdempotencyKey: false,
};
const candidate: AdmissionCandidate = {
  direction: 'LONG',
  requestedNotionalUsd: 12,
  quote: { bestBid: 0.54, bestAsk: 0.56, liquidity: 20000 },
  quoteAgeMs: 900,
  hoursToResolution: 6,
};

test('clean candidate on an empty book is admitted with sized collateral', () => {
  const r = evaluateAdmission(limits, costParams, candidate, emptyPortfolio);
  assert.equal(r.admitted, true, JSON.stringify(r.rejections));
  assert.ok(r.sizedShares > 0);
  assert.ok(r.requiredCollateralMicros > 0n);
  assert.equal(r.riskLimitVersion, 'risk-test');
});

test('every gate rejects with its own stable code', () => {
  const cases: Array<[Partial<AdmissionCandidate>, Partial<PortfolioState>, string]> = [
    [{ quoteAgeMs: 60_001 }, {}, 'STALE_QUOTE'],
    [{ quote: { bestBid: 0.4, bestAsk: 0.55, liquidity: 20000 } }, {}, 'SPREAD_TOO_WIDE'],
    [{ quote: { bestBid: 0.54, bestAsk: 0.56, liquidity: 500 } }, {}, 'LIQUIDITY_TOO_LOW'],
    [{ hoursToResolution: 25 }, {}, 'HORIZON_EXCEEDED'],
    [{ hoursToResolution: undefined }, {}, 'HORIZON_EXCEEDED'],
    [{ hoursToResolution: -1 }, {}, 'HORIZON_EXCEEDED'],
    [{}, { availableCollateralMicros: toMicros(1) }, 'INSUFFICIENT_COLLATERAL'],
    [{}, { grossExposureMicros: toMicros(395) }, 'GROSS_CAP'],
    [{}, { netExposureMicros: toMicros(295) }, 'NET_CAP'],
    [{}, { instrumentExposureMicros: toMicros(35) }, 'INSTRUMENT_CAP'],
    [{}, { walletExposureMicros: toMicros(115) }, 'WALLET_CAP'],
    [{}, { categoryExposureMicros: toMicros(245) }, 'CATEGORY_CAP'],
    [{}, { dailyTurnoverMicros: toMicros(295) }, 'TURNOVER_CAP'],
    [{}, { openPositionCount: 25, openedNewInstrument: true }, 'MAX_CONCURRENT'],
    [{}, { duplicateIdempotencyKey: true }, 'DUPLICATE'],
  ];
  for (const [candOver, portOver, code] of cases) {
    const r = evaluateAdmission(limits, costParams, { ...candidate, ...candOver }, { ...emptyPortfolio, ...portOver });
    assert.equal(r.admitted, false, `expected rejection for ${code}`);
    assert.ok(r.rejections.some((x) => x.code === code), `${code} missing from ${JSON.stringify(r.rejections)}`);
  }
});

test('exact cap boundary admits; one micro over rejects', () => {
  const probe = evaluateAdmission(limits, costParams, candidate, emptyPortfolio);
  assert.ok(probe.admitted);
  const required = probe.requiredCollateralMicros;
  const atCap = evaluateAdmission(limits, costParams, candidate, {
    ...emptyPortfolio,
    grossExposureMicros: limits.maxGrossExposureMicros - required,
  });
  assert.equal(atCap.admitted, true);
  const overCap = evaluateAdmission(limits, costParams, candidate, {
    ...emptyPortfolio,
    grossExposureMicros: limits.maxGrossExposureMicros - required + 1n,
  });
  assert.equal(overCap.admitted, false);
  assert.ok(overCap.rejections.some((x) => x.code === 'GROSS_CAP'));
});

test('all simultaneous violations are reported, not just the first', () => {
  const r = evaluateAdmission(limits, costParams, { ...candidate, quoteAgeMs: 120_000, hoursToResolution: 48 }, {
    ...emptyPortfolio,
    availableCollateralMicros: 0n,
    duplicateIdempotencyKey: true,
  });
  const codes = r.rejections.map((x) => x.code);
  for (const code of ['STALE_QUOTE', 'HORIZON_EXCEEDED', 'INSUFFICIENT_COLLATERAL', 'DUPLICATE']) {
    assert.ok(codes.includes(code as any), `${code} missing from ${codes.join(',')}`);
  }
});

test('short admission includes the short-only collateral buffer', () => {
  const long = evaluateAdmission(limits, costParams, candidate, emptyPortfolio);
  const short = evaluateAdmission(limits, costParams, { ...candidate, direction: 'SHORT' }, emptyPortfolio);
  assert.ok(long.admitted && short.admitted);
  // short collateral = shares*(1-price) + fees + buffer; with price ~0.55 and a
  // 0.02/share buffer the short must reserve more than (1-price) alone.
  const shortPerShare = Number(short.requiredCollateralMicros) / 1e6 / short.sizedShares;
  assert.ok(shortPerShare > (1 - short.cost.effectivePrice) + 0.019, `short per-share collateral ${shortPerShare} missing buffer`);
});

test('max-concurrent applies only when opening a new instrument', () => {
  const atCap = { ...emptyPortfolio, openPositionCount: 25 };
  const increase = evaluateAdmission(limits, costParams, candidate, { ...atCap, openedNewInstrument: false });
  assert.equal(increase.admitted, true, JSON.stringify(increase.rejections));
  const open = evaluateAdmission(limits, costParams, candidate, { ...atCap, openedNewInstrument: true });
  assert.equal(open.admitted, false);
});

test('unexecutable cost stops evaluation with NOT_EXECUTABLE only', () => {
  const r = evaluateAdmission(limits, costParams, { ...candidate, quote: { bestBid: 0.985, bestAsk: 0.999, liquidity: 1200 }, requestedNotionalUsd: 4000 }, emptyPortfolio);
  assert.equal(r.admitted, false);
  assert.ok(r.rejections.some((x) => x.code === 'NOT_EXECUTABLE'));
  assert.equal(r.sizedShares, 0);
  assert.equal(r.requiredCollateralMicros, 0n);
});

test('invalid limits fail loud', () => {
  assert.throws(() => evaluateAdmission({ ...limits, maxGrossExposureMicros: 0n }, costParams, candidate, emptyPortfolio));
  assert.throws(() => evaluateAdmission({ ...limits, maxSpread: 2 }, costParams, candidate, emptyPortfolio));
});
