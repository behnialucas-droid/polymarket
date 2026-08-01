// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Maps an admitted source signal to a signed strategy-action request.
 * Source side is evidence: BUY becomes a Hermes LONG action, SELL becomes a
 * Hermes SHORT action. Nothing here nets or closes opposite inventory —
 * reductions are separate explicit actions. Fails closed on missing identity. */
import { sourceSideToAction } from './signedPaperLedger.ts';
import type { AdmissionResult } from './admission.ts';
import type { SignedPaperLedgerRequest } from './signedPaperLedgerDb.ts';

export interface SignedRequestInput {
  side: 'BUY' | 'SELL';
  paperAccountId: number;
  observedTradeId: number;
  decisionJournalId: number;
  conditionId: string | null | undefined;
  assetId: string | null | undefined;
  marketId: string;
  outcome: string | null | undefined;
  providerEventId: string | undefined;
  /** Whether the account already holds same-direction shares in this instrument (read in-tx). */
  hasSameDirectionExposure: boolean;
  admission: AdmissionResult;
  shortBufferPerShare: number;
}

export type SignedRequestResult =
  | { ok: true; request: SignedPaperLedgerRequest }
  | { ok: false; paperAction: 'REJECTED_MISSING_INSTRUMENT' | 'REJECTED_NOT_ADMITTED'; reason: string };

export function buildSignedRequest(input: SignedRequestInput): SignedRequestResult {
  if (!input.admission.admitted) {
    return {
      ok: false,
      paperAction: 'REJECTED_NOT_ADMITTED',
      reason: input.admission.rejections.map((r) => r.code).join(',') || 'not admitted',
    };
  }
  if (!input.conditionId || !input.assetId || !input.outcome) {
    return {
      ok: false,
      paperAction: 'REJECTED_MISSING_INSTRUMENT',
      reason: 'observed trade lacks conditionId/assetId/outcome; refusing to guess instrument identity',
    };
  }

  const action = sourceSideToAction(input.side, input.hasSameDirectionExposure);
  const direction = input.side === 'BUY' ? 'LONG' : 'SHORT';
  const shares = input.admission.sizedShares;
  const price = input.admission.cost.effectivePrice;
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
    return { ok: false, paperAction: 'REJECTED_NOT_ADMITTED', reason: 'admitted size or price is not executable' };
  }

  return {
    ok: true,
    request: {
      paperAccountId: input.paperAccountId,
      observedTradeId: input.observedTradeId,
      decisionJournalId: input.decisionJournalId,
      conditionId: input.conditionId,
      assetId: input.assetId,
      marketId: input.marketId,
      outcome: input.outcome,
      action,
      requestedShares: shares,
      executionPrice: price,
      entryFees: Number(input.admission.cost.feesMicros) / 1_000_000,
      collateralBuffer: direction === 'SHORT' ? input.shortBufferPerShare * shares : 0,
      idempotencyKey: `polymarket:${input.providerEventId ?? `observed:${input.observedTradeId}`}:${action.toLowerCase()}:v2`,
      reason: `copy of source ${input.side} via admission (${input.admission.riskLimitVersion}/${input.admission.cost.costModelVersion})`,
    },
  };
}
