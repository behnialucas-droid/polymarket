// GENERATED FROM runtime/src/lib — DO NOT EDIT. Run: npm --prefix runtime run sync-dashboard-lib
export type PositionDirection = 'LONG' | 'SHORT';
export type StrategyAction =
  | 'OPEN_LONG'
  | 'OPEN_SHORT'
  | 'INCREASE_LONG'
  | 'INCREASE_SHORT'
  | 'REDUCE_LONG'
  | 'REDUCE_SHORT'
  | 'FLATTEN';

export interface SignedLot {
  id: number;
  direction: PositionDirection;
  openedShares: number;
  remainingShares: number;
  entryPrice: number;
  entryFees: number;
  collateral: number;
}

export interface LotClose {
  id: number;
  direction: PositionDirection;
  closingShares: number;
  remainingShares: number;
  allocatedEntryFees: number;
  releasedCollateral: number;
  costBasis: number;
}

export interface Allocation {
  closes: LotClose[];
  matchedShares: number;
  unmatchedShares: number;
  closedCostBasis: number;
  releasedCollateral: number;
}

export interface SignedPosition {
  longShares: number;
  shortShares: number;
  longCostBasis: number;
  shortCollateral: number;
}

export interface StrategyActionResult {
  action: StrategyAction;
  direction: PositionDirection;
  requestedShares: number;
  closedShares: number;
  openedShares: number;
  unmatchedShares: number;
  entryCollateral: number;
  releasedCollateral: number;
  realizedPnl: number;
  closes: LotClose[];
}

export interface SignedActionRequest {
  action: StrategyAction;
  requestedShares: number;
  executionPrice: number;
  entryFees: number;
  exitFees?: number;
  collateralBuffer: number;
}

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
}

function nonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
}

function price(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new Error('executionPrice must be in (0, 1)');
}

export function actionDirection(action: StrategyAction): PositionDirection {
  if (action.endsWith('_SHORT')) return 'SHORT';
  if (action.endsWith('_LONG')) return 'LONG';
  throw new Error(`action ${action} has no opening direction`);
}

export function sourceSideToAction(side: 'BUY' | 'SELL', increase = false): StrategyAction {
  if (side === 'BUY') return increase ? 'INCREASE_LONG' : 'OPEN_LONG';
  if (side === 'SELL') return increase ? 'INCREASE_SHORT' : 'OPEN_SHORT';
  throw new Error(`unsupported source side ${side}`);
}

export function collateralFor(direction: PositionDirection, shares: number, executionPrice: number, fees: number, buffer: number): number {
  positive(shares, 'shares');
  price(executionPrice);
  nonNegative(fees, 'fees');
  nonNegative(buffer, 'collateralBuffer');
  const gross = direction === 'LONG' ? shares * executionPrice : shares * (1 - executionPrice);
  return gross + fees + (direction === 'SHORT' ? buffer : 0);
}

function allocateLots(lots: SignedLot[], lotDirection: PositionDirection, requestedShares: number): Allocation {
  positive(requestedShares, 'requestedShares');
  let remaining = requestedShares;
  let closedCostBasis = 0;
  let releasedCollateral = 0;
  const closes: LotClose[] = [];

  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.direction !== lotDirection) continue;
    positive(lot.openedShares, 'lot.openedShares');
    nonNegative(lot.remainingShares, 'lot.remainingShares');
    if (lot.remainingShares > lot.openedShares) throw new Error('lot remainingShares exceeds openedShares');
    price(lot.entryPrice);
    nonNegative(lot.entryFees, 'lot.entryFees');
    nonNegative(lot.collateral, 'lot.collateral');
    const closingShares = Math.min(lot.remainingShares, remaining);
    if (closingShares <= 0) continue;
    const ratio = closingShares / lot.openedShares;
    const allocatedEntryFees = lot.entryFees * ratio;
    const collateral = lot.collateral * ratio;
    const costBasis = lot.direction === 'LONG'
      ? closingShares * lot.entryPrice + allocatedEntryFees
      : closingShares * (1 - lot.entryPrice) + allocatedEntryFees;
    closes.push({
      id: lot.id,
      direction: lot.direction,
      closingShares,
      remainingShares: lot.remainingShares - closingShares,
      allocatedEntryFees,
      releasedCollateral: collateral,
      costBasis,
    });
    closedCostBasis += costBasis;
    releasedCollateral += collateral;
    remaining -= closingShares;
  }

  return {
    closes,
    matchedShares: requestedShares - remaining,
    unmatchedShares: remaining,
    closedCostBasis,
    releasedCollateral,
  };
}

export function allocateOppositeLots(lots: SignedLot[], direction: PositionDirection, requestedShares: number): Allocation {
  return allocateLots(lots, direction === 'LONG' ? 'SHORT' : 'LONG', requestedShares);
}

export function applySignedAction(lots: SignedLot[], request: SignedActionRequest): StrategyActionResult {
  positive(request.requestedShares, 'requestedShares');
  price(request.executionPrice);
  nonNegative(request.entryFees, 'entryFees');
  nonNegative(request.exitFees ?? 0, 'exitFees');
  nonNegative(request.collateralBuffer, 'collateralBuffer');

  if (request.action === 'REDUCE_LONG' || request.action === 'REDUCE_SHORT') {
    const direction = actionDirection(request.action);
    const allocation = allocateLots(lots, direction, request.requestedShares);
    const exitFees = request.exitFees ?? 0;
    const realizedPnl = allocation.closes.reduce((total, close) => {
      const gross = close.direction === 'LONG'
        ? close.closingShares * request.executionPrice
        : close.closingShares * (1 - request.executionPrice);
      return total + gross - close.costBasis - exitFees * (close.closingShares / allocation.matchedShares);
    }, 0);
    return {
      action: request.action,
      direction,
      requestedShares: request.requestedShares,
      closedShares: allocation.matchedShares,
      openedShares: 0,
      unmatchedShares: allocation.unmatchedShares,
      entryCollateral: 0,
      releasedCollateral: allocation.releasedCollateral,
      realizedPnl,
      closes: allocation.closes,
    };
  }

  if (request.action === 'FLATTEN') {
    throw new Error('FLATTEN requires direction-specific orchestration');
  }

  const direction = actionDirection(request.action);
  return {
    action: request.action,
    direction,
    requestedShares: request.requestedShares,
    closedShares: 0,
    openedShares: request.requestedShares,
    unmatchedShares: 0,
    entryCollateral: collateralFor(direction, request.requestedShares, request.executionPrice, request.entryFees, request.collateralBuffer),
    releasedCollateral: 0,
    realizedPnl: 0,
    closes: [],
  };
}

export function markPnl(direction: PositionDirection, shares: number, entryPrice: number, markPrice: number, entryCosts = 0): number {
  positive(shares, 'shares');
  price(entryPrice);
  price(markPrice);
  nonNegative(entryCosts, 'entryCosts');
  return direction === 'LONG'
    ? shares * (markPrice - entryPrice) - entryCosts
    : shares * (entryPrice - markPrice) - entryCosts;
}

export function settlementPnl(direction: PositionDirection, shares: number, entryPrice: number, settlementPrice: 0 | 1, entryCosts = 0, exitFees = 0): number {
  positive(shares, 'shares');
  price(entryPrice);
  nonNegative(entryCosts, 'entryCosts');
  nonNegative(exitFees, 'exitFees');
  const gross = direction === 'LONG'
    ? shares * (settlementPrice - entryPrice)
    : shares * (entryPrice - settlementPrice);
  return gross - entryCosts - exitFees;
}
