// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
/** Settlement DB orchestration: record resolution evidence, then finalize
 * positions from CONFIRMED evidence only. Both entry points are idempotent —
 * a rerun after any crash is a no-op for already-settled positions. */
import type postgres from 'postgres';
import type { DataAdapter } from '../adapters/types.ts';
import { evaluateResolution, lotInvalidationPnl, lotSettlementPnl, settlementPayout, type SettleableLot } from './settlement.ts';

/** Fetch markets of open signed positions and store resolution observations. */
export async function recordResolutionEvidence(db: postgres.Sql, adapter: DataAdapter): Promise<number> {
  const openMarkets = await db`
    SELECT DISTINCT i."marketId", i."conditionId"
    FROM "SignedPaperPosition" p
    JOIN "PaperInstrument" i ON i."id" = p."paperInstrumentId"
    WHERE p."status" = 'open' AND (p."longShares" > 0 OR p."shortShares" > 0)
  `;
  let recorded = 0;
  for (const row of openMarkets) {
    const confirmed = await db`
      SELECT 1 FROM "MarketResolutionEvidence"
      WHERE "conditionId" = ${row.conditionId} AND "status" IN ('confirmed', 'invalidated')
    `;
    if (confirmed.length) continue;

    let market;
    try {
      market = await adapter.fetchMarket(row.marketId);
    } catch {
      continue; // provider unavailable: no evidence, no guess
    }
    const evaluation = evaluateResolution(market);
    if (!evaluation) continue;

    if (evaluation.status === 'proposed') {
      // One proposed observation per (condition, outcome) is enough evidence;
      // re-inserting every cycle would grow the table without adding information.
      const already = await db`
        SELECT 1 FROM "MarketResolutionEvidence"
        WHERE "conditionId" = ${row.conditionId}
          AND "status" = 'proposed'
          AND "resolvedOutcome" IS NOT DISTINCT FROM ${evaluation.resolvedOutcome}
      `;
      if (already.length) continue;
    }

    try {
      await db`
        INSERT INTO "MarketResolutionEvidence" ("marketId", "conditionId", "resolvedOutcome", "status", "resolutionSource", "rawJson")
        VALUES (${row.marketId}, ${row.conditionId}, ${evaluation.resolvedOutcome}, ${evaluation.status}, ${evaluation.resolutionSource},
                ${JSON.stringify({ resolved: market.resolved, resolvedOutcome: market.resolvedOutcome, raw: (market.raw as any)?.umaResolutionStatus ?? null })})
      `;
      recorded++;
    } catch {
      // Partial-unique violation from a concurrent recorder: already recorded.
    }
  }
  return recorded;
}

/** Settle every open signed position whose condition has confirmed evidence. */
export async function finalizeSettlements(db: postgres.Sql): Promise<number> {
  const settleable = await db`
    SELECT p."id" AS "positionId", p."paperAccountId", i."outcome" AS "instrumentOutcome",
           e."resolvedOutcome", e."conditionId"
    FROM "SignedPaperPosition" p
    JOIN "PaperInstrument" i ON i."id" = p."paperInstrumentId"
    JOIN "MarketResolutionEvidence" e ON e."conditionId" = i."conditionId" AND e."status" = 'confirmed'
    WHERE p."status" = 'open'
  `;
  let settled = 0;
  for (const row of settleable) {
    const done = await db.begin(async (tx) => {
      const positions = await tx`
        SELECT * FROM "SignedPaperPosition" WHERE "id" = ${row.positionId} FOR UPDATE
      `;
      const position = positions[0];
      if (!position || position.status !== 'open') return false;

      const idempotencyKey = `settle:${row.conditionId}:${row.positionId}:v1`;
      const existing = await tx`
        SELECT 1 FROM "SignedPaperLedgerEntry" WHERE "idempotencyKey" = ${idempotencyKey}
      `;
      if (existing.length) {
        // Effect exists but projection was left open by a crash: repair projection only.
        await tx`
          UPDATE "SignedPaperPosition"
          SET "status" = 'resolved', "longShares" = 0, "shortShares" = 0, "netShares" = 0,
              "reservedCollateral" = 0, "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${row.positionId}
        `;
        return false;
      }

      // Resolve the anchor action BEFORE any mutation: a plain `return` from
      // db.begin() COMMITS, so bailing out after zeroing lots would burn shares.
      const anyAction = await tx`
        SELECT a."id" FROM "PaperStrategyAction" a
        JOIN "SignedPaperLot" l ON l."paperStrategyActionId" = a."id"
        WHERE l."signedPaperPositionId" = ${row.positionId}
        ORDER BY a."id" LIMIT 1
      `;
      if (!anyAction.length) return false;

      const lots = await tx`
        SELECT * FROM "SignedPaperLot"
        WHERE "signedPaperPositionId" = ${row.positionId} AND "remainingShares" > 0
        ORDER BY "openedAt", "id"
        FOR UPDATE
      `;
      const payout = settlementPayout(String(row.resolvedOutcome), String(row.instrumentOutcome));
      let realizedDelta = 0;
      let settledShares = 0;
      for (const lot of lots) {
        const settleableLot: SettleableLot = {
          direction: lot.direction,
          openedShares: Number(lot.openedShares),
          remainingShares: Number(lot.remainingShares),
          entryPrice: Number(lot.entryPrice),
          entryFees: Number(lot.entryFees),
        };
        realizedDelta += lotSettlementPnl(settleableLot, payout);
        settledShares += settleableLot.remainingShares;
        await tx`
          UPDATE "SignedPaperLot"
          SET "remainingShares" = 0, "closedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${lot.id}
        `;
      }
      const releasedCollateral = Number(position.reservedCollateral);
      realizedDelta = Math.round(realizedDelta * 1e6) / 1e6;

      await tx`
        INSERT INTO "SignedPaperLedgerEntry" (
          "paperAccountId", "signedPaperPositionId", "paperStrategyActionId", "eventType",
          "quantityShares", "price", "collateralDelta", "realizedPnlDelta", "idempotencyKey", "metadataJson"
        ) VALUES (
          ${row.paperAccountId}, ${row.positionId}, ${anyAction[0].id}, 'SETTLE',
          ${settledShares}, ${payout}, ${-releasedCollateral}, ${realizedDelta}, ${idempotencyKey},
          ${JSON.stringify({ conditionId: row.conditionId, resolvedOutcome: row.resolvedOutcome, instrumentOutcome: row.instrumentOutcome })}
        )
      `;
      await tx`
        UPDATE "SignedPaperPosition"
        SET "status" = 'resolved', "longShares" = 0, "shortShares" = 0, "netShares" = 0,
            "reservedCollateral" = 0, "realizedPnl" = "realizedPnl" + ${realizedDelta},
            "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${row.positionId}
      `;
      return true;
    });
    if (done) settled++;
  }

  // Invalidated markets: refund collateral, sink entry fees, no outcome payout.
  const invalidatable = await db`
    SELECT p."id" AS "positionId", p."paperAccountId", e."conditionId"
    FROM "SignedPaperPosition" p
    JOIN "PaperInstrument" i ON i."id" = p."paperInstrumentId"
    JOIN "MarketResolutionEvidence" e ON e."conditionId" = i."conditionId" AND e."status" = 'invalidated'
    WHERE p."status" = 'open'
  `;
  for (const row of invalidatable) {
    const done = await db.begin(async (tx) => {
      const positions = await tx`SELECT * FROM "SignedPaperPosition" WHERE "id" = ${row.positionId} FOR UPDATE`;
      const position = positions[0];
      if (!position || position.status !== 'open') return false;
      const idempotencyKey = `invalidate:${row.conditionId}:${row.positionId}:v1`;
      const existing = await tx`SELECT 1 FROM "SignedPaperLedgerEntry" WHERE "idempotencyKey" = ${idempotencyKey}`;
      if (existing.length) return false;
      // Anchor action first — a bare `return` COMMITS, so never mutate before
      // every precondition is settled.
      const anyAction = await tx`
        SELECT a."id" FROM "PaperStrategyAction" a
        JOIN "SignedPaperLot" l ON l."paperStrategyActionId" = a."id"
        WHERE l."signedPaperPositionId" = ${row.positionId}
        ORDER BY a."id" LIMIT 1
      `;
      if (!anyAction.length) return false;
      const lots = await tx`
        SELECT * FROM "SignedPaperLot"
        WHERE "signedPaperPositionId" = ${row.positionId} AND "remainingShares" > 0 FOR UPDATE
      `;
      let realizedDelta = 0;
      let shares = 0;
      for (const lot of lots) {
        realizedDelta += lotInvalidationPnl({
          direction: lot.direction,
          openedShares: Number(lot.openedShares),
          remainingShares: Number(lot.remainingShares),
          entryPrice: Number(lot.entryPrice),
          entryFees: Number(lot.entryFees),
        });
        shares += Number(lot.remainingShares);
        await tx`UPDATE "SignedPaperLot" SET "remainingShares" = 0, "closedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lot.id}`;
      }
      realizedDelta = Math.round(realizedDelta * 1e6) / 1e6;
      await tx`
        INSERT INTO "SignedPaperLedgerEntry" (
          "paperAccountId", "signedPaperPositionId", "paperStrategyActionId", "eventType",
          "quantityShares", "price", "collateralDelta", "realizedPnlDelta", "idempotencyKey", "metadataJson"
        ) VALUES (
          ${row.paperAccountId}, ${row.positionId}, ${anyAction[0].id}, 'SETTLE',
          ${shares}, NULL, ${-Number(position.reservedCollateral)}, ${realizedDelta}, ${idempotencyKey},
          ${JSON.stringify({ conditionId: row.conditionId, invalidated: true })}
        )
      `;
      await tx`
        UPDATE "SignedPaperPosition"
        SET "status" = 'invalidated', "longShares" = 0, "shortShares" = 0, "netShares" = 0,
            "reservedCollateral" = 0, "realizedPnl" = "realizedPnl" + ${realizedDelta},
            "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${row.positionId}
      `;
      return true;
    });
    if (done) settled++;
  }
  return settled;
}
