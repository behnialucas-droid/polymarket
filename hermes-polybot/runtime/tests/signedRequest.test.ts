import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignedRequest, type SignedRequestInput } from '../src/lib/engine/signedRequest.ts';
import type { AdmissionResult } from '../src/lib/engine/admission.ts';

const admitted: AdmissionResult = {
  admitted: true,
  rejections: [],
  sizedShares: 20,
  requiredCollateralMicros: 12_000_000n,
  riskLimitVersion: 'risk-test',
  cost: {
    executable: true,
    costModelVersion: 'cost-test',
    effectivePrice: 0.57,
    expectedFillShares: 20,
    feesMicros: 22_800n,
    slippageMicros: 200_000n,
    impactBps: 3,
    latencyBps: 8,
  },
};

const base: SignedRequestInput = {
  side: 'SELL',
  paperAccountId: 7,
  observedTradeId: 11,
  decisionJournalId: 13,
  conditionId: 'cond-demo-eth-aug1',
  assetId: 'asset-demo-eth-aug1-yes',
  marketId: 'demo-eth-up-aug1',
  outcome: 'Yes',
  providerEventId: 'demo-alpha-eth-sell-1',
  hasSameDirectionExposure: false,
  admission: admitted,
  shortBufferPerShare: 0.02,
};

test('source SELL always becomes a SHORT action, never a long close', () => {
  const open = buildSignedRequest(base);
  assert.ok(open.ok);
  assert.equal(open.request.action, 'OPEN_SHORT');
  assert.ok(open.request.collateralBuffer > 0, 'short must carry a collateral buffer');
  const increase = buildSignedRequest({ ...base, hasSameDirectionExposure: true });
  assert.ok(increase.ok);
  assert.equal(increase.request.action, 'INCREASE_SHORT');
  for (const r of [open, increase]) {
    assert.ok(r.ok);
    assert.doesNotMatch(r.request.action, /LONG|CLOSE/);
  }
});

test('source BUY becomes an independent LONG action with no short buffer', () => {
  const open = buildSignedRequest({ ...base, side: 'BUY' });
  assert.ok(open.ok);
  assert.equal(open.request.action, 'OPEN_LONG');
  assert.equal(open.request.collateralBuffer, 0);
  const increase = buildSignedRequest({ ...base, side: 'BUY', hasSameDirectionExposure: true });
  assert.ok(increase.ok);
  assert.equal(increase.request.action, 'INCREASE_LONG');
});

test('request carries admission economics and a v2 idempotency key', () => {
  const r = buildSignedRequest(base);
  assert.ok(r.ok);
  assert.equal(r.request.requestedShares, 20);
  assert.equal(r.request.executionPrice, 0.57);
  assert.ok(Math.abs(r.request.entryFees - 0.0228) < 1e-9);
  assert.equal(r.request.idempotencyKey, 'polymarket:demo-alpha-eth-sell-1:open_short:v2');
  const noProvider = buildSignedRequest({ ...base, providerEventId: undefined });
  assert.ok(noProvider.ok);
  assert.equal(noProvider.request.idempotencyKey, 'polymarket:observed:11:open_short:v2');
});

test('missing instrument identity fails closed, never guessed', () => {
  for (const missing of [{ conditionId: null }, { assetId: undefined }, { outcome: null }] as const) {
    const r = buildSignedRequest({ ...base, ...missing });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.paperAction, 'REJECTED_MISSING_INSTRUMENT');
  }
});

test('unadmitted or unexecutable candidates cannot form a signed request', () => {
  const rejected = buildSignedRequest({
    ...base,
    admission: { ...admitted, admitted: false, rejections: [{ code: 'GROSS_CAP', detail: 'x' }] },
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.paperAction, 'REJECTED_NOT_ADMITTED');
    assert.match(rejected.reason, /GROSS_CAP/);
  }
  const badPrice = buildSignedRequest({
    ...base,
    admission: { ...admitted, cost: { ...admitted.cost, effectivePrice: 1.2 } },
  });
  assert.equal(badPrice.ok, false);
});
