// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
import type postgres from 'postgres';

export type PaperAction = 'BUY_OPEN' | 'BUY_INCREASE' | 'SELL_CLOSE' | 'SELL_NO_POSITION';

export interface PaperLedgerRequest {
  paperAccountId: number;
  observedTradeId: number;
  decisionJournalId: number;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  quantityShares: number;
  entryPrice: number;
  notional: number;
  idempotencyKey: string;
}

export interface PaperLedgerResult {
  action: PaperAction;
  positionId: number | null;
  matchedShares: number;
  unmatchedShares: number;
  duplicate: boolean;
}

function finitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
}

function validPrice(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new Error('entryPrice must be in (0, 1)');
}

export interface OpenLot {
  id: number;
  openedShares: number;
  remainingShares: number;
  costBasis: number;
}

export interface LotClose {
  id: number;
  closingShares: number;
  remainingShares: number;
  costBasis: number;
}

export function allocateFifoClose(lots: OpenLot[], requestedShares: number): { closes: LotClose[]; matchedShares: number; unmatchedShares: number; closedCostBasis: number } {
  finitePositive(requestedShares, 'requestedShares');
  let remaining = requestedShares;
  let closedCostBasis = 0;
  const closes: LotClose[] = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    finitePositive(lot.openedShares, 'openedShares');
    if (!Number.isFinite(lot.remainingShares) || lot.remainingShares < 0 || lot.remainingShares > lot.openedShares) throw new Error('invalid lot remainingShares');
    if (!Number.isFinite(lot.costBasis) || lot.costBasis < 0) throw new Error('invalid lot costBasis');
    const closingShares = Math.min(lot.remainingShares, remaining);
    if (closingShares <= 0) continue;
    const costBasis = lot.costBasis * (closingShares / lot.openedShares);
    const remainingShares = lot.remainingShares - closingShares;
    closes.push({ id: lot.id, closingShares, remainingShares, costBasis });
    closedCostBasis += costBasis;
    remaining -= closingShares;
  }
  return {
    closes,
    matchedShares: requestedShares - remaining,
    unmatchedShares: remaining,
    closedCostBasis,
  };
}

export async function getPaperAccount(db: postgres.Sql, isDemo: boolean): Promise<number> {
  const strategyKey = 'hermes-long-only-v1';
  const rows = await db`
    INSERT INTO "PaperAccount" ("strategyKey", "isDemo")
    VALUES (${strategyKey}, ${isDemo ? 1 : 0})
    ON CONFLICT ("strategyKey", "isDemo") DO UPDATE SET "strategyKey" = EXCLUDED."strategyKey"
    RETURNING "id"
  `;
  return Number(rows[0].id);
}

export async function getOpenPaperPositionShares(
  db: postgres.Sql,
  paperAccountId: number,
  marketId: string,
  outcome: string,
): Promise<number> {
  const rows = await db`
    SELECT "quantityShares" FROM "PaperPosition"
    WHERE "paperAccountId" = ${paperAccountId} AND "marketId" = ${marketId} AND "outcome" = ${outcome}
  `;
  return rows.length ? Number(rows[0].quantityShares) : 0;
}

export async function applyPaperLedgerActionInTransaction(db: postgres.Sql | postgres.TransactionSql, request: PaperLedgerRequest): Promise<PaperLedgerResult> {
  finitePositive(request.quantityShares, 'quantityShares');
  finitePositive(request.notional, 'notional');
  validPrice(request.entryPrice);
  if (!request.marketId || !request.outcome) throw new Error('marketId and outcome are required');

  const existing = await db`
      SELECT "paperPositionId", "eventType", "metadataJson"
      FROM "PaperLedgerEntry"
      WHERE "idempotencyKey" = ${request.idempotencyKey}
    `;
    if (existing.length) {
      const metadata = JSON.parse(existing[0].metadataJson ?? '{}');
      return {
        action: existing[0].eventType as PaperAction,
        positionId: existing[0].paperPositionId == null ? null : Number(existing[0].paperPositionId),
        matchedShares: Number(metadata.matchedShares ?? 0),
        unmatchedShares: Number(metadata.unmatchedShares ?? 0),
        duplicate: true,
      };
    }

    const positionRows = await db`
      SELECT * FROM "PaperPosition"
      WHERE "paperAccountId" = ${request.paperAccountId}
        AND "marketId" = ${request.marketId}
        AND "outcome" = ${request.outcome}
      FOR UPDATE
    `;
    const position = positionRows[0];

    if (request.side === 'SELL' && (!position || Number(position.quantityShares) <= 0)) {
      await db`
        INSERT INTO "PaperLedgerEntry" (
          "paperAccountId", "eventType", "sourceObservedTradeId", "sourceDecisionJournalId",
          "idempotencyKey", "quantityShares", "price", "metadataJson"
        )
        VALUES (
          ${request.paperAccountId}, 'SELL_NO_POSITION', ${request.observedTradeId}, ${request.decisionJournalId},
          ${request.idempotencyKey}, ${request.quantityShares}, ${request.entryPrice},
          ${JSON.stringify({ matchedShares: 0, unmatchedShares: request.quantityShares })}
        )
      `;
      return { action: 'SELL_NO_POSITION', positionId: null, matchedShares: 0, unmatchedShares: request.quantityShares, duplicate: false };
    }

    if (request.side === 'BUY') {
      let positionId: number;
      let action: 'BUY_OPEN' | 'BUY_INCREASE';
      if (position) {
        positionId = Number(position.id);
        action = Number(position.quantityShares) > 0 ? 'BUY_INCREASE' : 'BUY_OPEN';
        const totalShares = Number(position.quantityShares) + request.quantityShares;
        const totalCostBasis = Number(position.costBasis) + request.notional;
        await db`
          UPDATE "PaperPosition"
          SET "quantityShares" = ${totalShares}, "costBasis" = ${totalCostBasis},
              "averageEntryPrice" = ${totalCostBasis / totalShares}, "status" = 'open',
              "openedAt" = COALESCE("openedAt", CURRENT_TIMESTAMP), "closedAt" = NULL,
              "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${positionId}
        `;
      } else {
        const created = await db`
          INSERT INTO "PaperPosition" ("paperAccountId", "marketId", "outcome", "quantityShares", "averageEntryPrice", "costBasis", "openedAt")
          VALUES (${request.paperAccountId}, ${request.marketId}, ${request.outcome}, ${request.quantityShares}, ${request.notional / request.quantityShares}, ${request.notional}, CURRENT_TIMESTAMP)
          RETURNING "id"
        `;
        positionId = Number(created[0].id);
        action = 'BUY_OPEN';
      }
      await db`
        INSERT INTO "PaperPositionLot" ("paperPositionId", "sourceDecisionJournalId", "openedShares", "remainingShares", "entryPrice", "costBasis")
        VALUES (${positionId}, ${request.decisionJournalId}, ${request.quantityShares}, ${request.quantityShares}, ${request.entryPrice}, ${request.notional})
      `;
      await db`
        INSERT INTO "PaperLedgerEntry" (
          "paperAccountId", "paperPositionId", "eventType", "sourceObservedTradeId", "sourceDecisionJournalId",
          "idempotencyKey", "quantityShares", "price", "costBasisDelta", "metadataJson"
        )
        VALUES (
          ${request.paperAccountId}, ${positionId}, ${action}, ${request.observedTradeId}, ${request.decisionJournalId},
          ${request.idempotencyKey}, ${request.quantityShares}, ${request.entryPrice}, ${request.notional},
          ${JSON.stringify({ matchedShares: request.quantityShares, unmatchedShares: 0 })}
        )
      `;
      return { action, positionId, matchedShares: request.quantityShares, unmatchedShares: 0, duplicate: false };
    }

    const positionId = Number(position.id);
    const availableShares = Number(position.quantityShares);
    const matchedShares = Math.min(availableShares, request.quantityShares);
    const unmatchedShares = request.quantityShares - matchedShares;
    const lots = await db`
      SELECT * FROM "PaperPositionLot"
      WHERE "paperPositionId" = ${positionId} AND "remainingShares" > 0
      ORDER BY "openedAt", "id"
      FOR UPDATE
    `;
    const allocation = allocateFifoClose(lots.map((lot) => ({
      id: Number(lot.id),
      openedShares: Number(lot.openedShares),
      remainingShares: Number(lot.remainingShares),
      costBasis: Number(lot.costBasis),
    })), matchedShares);
    if (allocation.unmatchedShares > 0) throw new Error('position lot invariant violated');
    for (const close of allocation.closes) {
      await db`
        UPDATE "PaperPositionLot"
        SET "remainingShares" = ${close.remainingShares}, "closedAt" = CASE WHEN ${close.remainingShares} = 0 THEN CURRENT_TIMESTAMP ELSE "closedAt" END
        WHERE "id" = ${close.id}
      `;
    }
    const closedCostBasis = allocation.closedCostBasis;
    const proceeds = matchedShares * request.entryPrice;
    const realizedPnl = proceeds - closedCostBasis;
    const remainingShares = availableShares - matchedShares;
    const remainingCostBasis = Math.max(0, Number(position.costBasis) - closedCostBasis);
    await db`
      UPDATE "PaperPosition"
      SET "quantityShares" = ${remainingShares}, "costBasis" = ${remainingCostBasis},
          "averageEntryPrice" = CASE WHEN ${remainingShares} = 0 THEN NULL ELSE ${remainingCostBasis / remainingShares} END,
          "realizedPnl" = "realizedPnl" + ${realizedPnl},
          "status" = CASE WHEN ${remainingShares} = 0 THEN 'closed' ELSE 'open' END,
          "closedAt" = CASE WHEN ${remainingShares} = 0 THEN CURRENT_TIMESTAMP ELSE NULL END,
          "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${positionId}
    `;
    await db`
      INSERT INTO "PaperLedgerEntry" (
        "paperAccountId", "paperPositionId", "eventType", "sourceObservedTradeId", "sourceDecisionJournalId",
        "idempotencyKey", "quantityShares", "price", "costBasisDelta", "realizedPnlDelta", "metadataJson"
      )
      VALUES (
        ${request.paperAccountId}, ${positionId}, 'SELL_CLOSE', ${request.observedTradeId}, ${request.decisionJournalId},
        ${request.idempotencyKey}, ${matchedShares}, ${request.entryPrice}, ${-closedCostBasis}, ${realizedPnl},
        ${JSON.stringify({ matchedShares, unmatchedShares })}
      )
    `;
  return { action: 'SELL_CLOSE', positionId, matchedShares, unmatchedShares, duplicate: false };
}

export async function applyPaperLedgerAction(
  db: postgres.Sql,
  request: PaperLedgerRequest,
): Promise<PaperLedgerResult> {
  return db.begin((tx) => applyPaperLedgerActionInTransaction(tx, request));
}
