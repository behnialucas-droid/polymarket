import type postgres from 'postgres';
import {
  applySignedAction,
  type SignedLot,
  type StrategyAction,
} from './signedPaperLedger.ts';

export interface SignedPaperLedgerRequest {
  paperAccountId: number;
  observedTradeId: number;
  decisionJournalId: number;
  conditionId: string;
  assetId: string;
  marketId: string;
  outcome: string;
  action: StrategyAction;
  requestedShares: number;
  executionPrice: number;
  entryFees: number;
  exitFees?: number;
  collateralBuffer: number;
  idempotencyKey: string;
  reason?: string;
}

export interface SignedPaperLedgerResult {
  actionId: number;
  positionId: number;
  closedShares: number;
  openedShares: number;
  unmatchedShares: number;
  reservedCollateral: number;
  releasedCollateral: number;
  realizedPnl: number;
  duplicate: boolean;
}

function finiteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
}

function finitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
}

function positionStatus(longShares: number, shortShares: number): 'open' | 'flat' {
  return longShares === 0 && shortShares === 0 ? 'flat' : 'open';
}

function ledgerType(action: StrategyAction): 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT' {
  if (action === 'OPEN_LONG' || action === 'INCREASE_LONG') return 'OPEN_LONG';
  if (action === 'OPEN_SHORT' || action === 'INCREASE_SHORT') return 'OPEN_SHORT';
  if (action === 'REDUCE_LONG') return 'CLOSE_LONG';
  if (action === 'REDUCE_SHORT') return 'CLOSE_SHORT';
  throw new Error(`unsupported signed ledger action ${action}`);
}

export async function getSignedPaperAccount(db: postgres.Sql, isDemo: boolean): Promise<number> {
  const rows = await db`
    INSERT INTO "PaperAccount" ("strategyKey", "isDemo")
    VALUES ('hermes-signed-v2', ${isDemo ? 1 : 0})
    ON CONFLICT ("strategyKey", "isDemo") DO UPDATE SET "strategyKey" = EXCLUDED."strategyKey"
    RETURNING "id"
  `;
  return Number(rows[0].id);
}

export async function applySignedPaperLedgerActionInTransaction(
  db: postgres.Sql | postgres.TransactionSql,
  request: SignedPaperLedgerRequest,
): Promise<SignedPaperLedgerResult> {
  finitePositive(request.requestedShares, 'requestedShares');
  finitePositive(request.executionPrice, 'executionPrice');
  if (request.executionPrice >= 1) throw new Error('executionPrice must be in (0, 1)');
  finiteNonNegative(request.entryFees, 'entryFees');
  finiteNonNegative(request.exitFees ?? 0, 'exitFees');
  finiteNonNegative(request.collateralBuffer, 'collateralBuffer');
  if (!request.conditionId || !request.assetId || !request.marketId || !request.outcome) {
    throw new Error('conditionId, assetId, marketId, and outcome are required');
  }

  const duplicate = await db`
    SELECT "id", "paperAccountId", "paperInstrumentId"
    FROM "PaperStrategyAction"
    WHERE "idempotencyKey" = ${request.idempotencyKey}
  `;
  if (duplicate.length) {
    const position = await db`
      SELECT "id", "reservedCollateral", "realizedPnl"
      FROM "SignedPaperPosition"
      WHERE "paperAccountId" = ${duplicate[0].paperAccountId}
        AND "paperInstrumentId" = ${duplicate[0].paperInstrumentId}
    `;
    if (!position.length) throw new Error('duplicate signed action has no position');
    return {
      actionId: Number(duplicate[0].id),
      positionId: Number(position[0].id),
      closedShares: 0,
      openedShares: 0,
      unmatchedShares: 0,
      reservedCollateral: Number(position[0].reservedCollateral),
      releasedCollateral: 0,
      realizedPnl: 0,
      duplicate: true,
    };
  }

  const instruments = await db`
    INSERT INTO "PaperInstrument" ("conditionId", "assetId", "outcome", "marketId")
    VALUES (${request.conditionId}, ${request.assetId}, ${request.outcome}, ${request.marketId})
    ON CONFLICT ("conditionId", "assetId", "outcome")
    DO UPDATE SET "marketId" = EXCLUDED."marketId"
    RETURNING "id"
  `;
  const instrumentId = Number(instruments[0].id);

  const created = await db`
    INSERT INTO "SignedPaperPosition" ("paperAccountId", "paperInstrumentId")
    VALUES (${request.paperAccountId}, ${instrumentId})
    ON CONFLICT ("paperAccountId", "paperInstrumentId") DO NOTHING
    RETURNING "id"
  `;
  const positions = await db`
    SELECT * FROM "SignedPaperPosition"
    WHERE "paperAccountId" = ${request.paperAccountId}
      AND "paperInstrumentId" = ${instrumentId}
    FOR UPDATE
  `;
  const position = positions[0] ?? created[0];
  if (!position) throw new Error('signed position was not created');
  const positionId = Number(position.id);

  const actionRows = await db`
    INSERT INTO "PaperStrategyAction" (
      "paperAccountId", "decisionJournalId", "sourceObservedTradeId", "paperInstrumentId",
      "actionType", "requestedShares", "executionPrice", "entryFees", "collateralBuffer",
      "idempotencyKey", "reason"
    ) VALUES (
      ${request.paperAccountId}, ${request.decisionJournalId}, ${request.observedTradeId}, ${instrumentId},
      ${request.action}, ${request.requestedShares}, ${request.executionPrice}, ${request.entryFees},
      ${request.collateralBuffer}, ${request.idempotencyKey}, ${request.reason ?? null}
    )
    RETURNING "id"
  `;
  const actionId = Number(actionRows[0].id);

  const lots = await db`
    SELECT * FROM "SignedPaperLot"
    WHERE "signedPaperPositionId" = ${positionId} AND "remainingShares" > 0
    ORDER BY "openedAt", "id"
    FOR UPDATE
  `;
  const signedLots: SignedLot[] = lots.map((lot) => ({
    id: Number(lot.id),
    direction: lot.direction,
    openedShares: Number(lot.openedShares),
    remainingShares: Number(lot.remainingShares),
    entryPrice: Number(lot.entryPrice),
    entryFees: Number(lot.entryFees),
    collateral: Number(lot.reservedCollateral),
  }));
  const result = applySignedAction(signedLots, request);

  for (const close of result.closes) {
    await db`
      UPDATE "SignedPaperLot"
      SET "remainingShares" = ${close.remainingShares},
          "closedAt" = CASE WHEN ${close.remainingShares} = 0 THEN CURRENT_TIMESTAMP ELSE "closedAt" END
      WHERE "id" = ${close.id}
    `;
  }

  if (result.openedShares > 0) {
    await db`
      INSERT INTO "SignedPaperLot" (
        "signedPaperPositionId", "paperStrategyActionId", "direction", "openedShares",
        "remainingShares", "entryPrice", "entryFees", "reservedCollateral"
      ) VALUES (
        ${positionId}, ${actionId}, ${result.direction}, ${result.openedShares},
        ${result.openedShares}, ${request.executionPrice}, ${request.entryFees}, ${result.entryCollateral}
      )
    `;
  }

  let longShares = Number(position.longShares);
  let shortShares = Number(position.shortShares);
  if (result.closedShares > 0) {
    if (result.direction === 'LONG') longShares -= result.closedShares;
    else shortShares -= result.closedShares;
  }
  if (result.openedShares > 0) {
    if (result.direction === 'LONG') longShares += result.openedShares;
    else shortShares += result.openedShares;
  }
  if (longShares < 0 || shortShares < 0) throw new Error('signed position invariant violated');

  const reservedCollateral = Number(position.reservedCollateral) + result.entryCollateral - result.releasedCollateral;
  if (reservedCollateral < 0) throw new Error('signed collateral invariant violated');
  await db`
    UPDATE "SignedPaperPosition"
    SET "longShares" = ${longShares}, "shortShares" = ${shortShares},
        "netShares" = ${longShares - shortShares}, "reservedCollateral" = ${reservedCollateral},
        "realizedPnl" = "realizedPnl" + ${result.realizedPnl},
        "status" = ${positionStatus(longShares, shortShares)}, "version" = "version" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${positionId}
  `;

  const eventType = ledgerType(request.action);
  await db`
    INSERT INTO "SignedPaperLedgerEntry" (
      "paperAccountId", "signedPaperPositionId", "paperStrategyActionId", "eventType",
      "quantityShares", "price", "collateralDelta", "realizedPnlDelta", "idempotencyKey", "metadataJson"
    ) VALUES (
      ${request.paperAccountId}, ${positionId}, ${actionId}, ${eventType},
      ${result.openedShares || result.closedShares}, ${request.executionPrice},
      ${result.entryCollateral - result.releasedCollateral}, ${result.realizedPnl},
      ${`${request.idempotencyKey}:effect`},
      ${JSON.stringify({ closedShares: result.closedShares, openedShares: result.openedShares, unmatchedShares: result.unmatchedShares })}
    )
  `;

  return {
    actionId,
    positionId,
    closedShares: result.closedShares,
    openedShares: result.openedShares,
    unmatchedShares: result.unmatchedShares,
    reservedCollateral,
    releasedCollateral: result.releasedCollateral,
    realizedPnl: result.realizedPnl,
    duplicate: false,
  };
}

export async function applySignedPaperLedgerAction(
  db: postgres.Sql,
  request: SignedPaperLedgerRequest,
): Promise<SignedPaperLedgerResult> {
  return db.begin((tx) => applySignedPaperLedgerActionInTransaction(tx, request));
}
