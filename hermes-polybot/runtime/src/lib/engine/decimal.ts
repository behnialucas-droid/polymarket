/** Exact money math on bigint micro-units (1e-6 USD / shares).
 * Boundary rule: `postgres` returns NUMERIC as strings — parse once at the
 * edge with toMicros(); every ledger-affecting sum/cap comparison happens in
 * bigint micros. Model coefficients (bps, exponents) may stay float because
 * model uncertainty dominates float epsilon; totals never accumulate in float. */

export const MICROS_SCALE = 1_000_000n;

const DECIMAL_RE = /^[+-]?(\d+)(?:\.(\d+))?$/;

export function toMicros(value: string | number): bigint {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? value.toFixed(6) : 'invalid')
    : value.trim();
  const match = DECIMAL_RE.exec(text);
  if (!match) throw new Error(`not a decimal value: ${String(value)}`);
  const negative = text.startsWith('-');
  const whole = BigInt(match[1]);
  const fracDigits = (match[2] ?? '').padEnd(7, '0');
  const frac = BigInt(fracDigits.slice(0, 6));
  const roundUp = fracDigits[6] >= '5' ? 1n : 0n;
  const magnitude = whole * MICROS_SCALE + frac + roundUp;
  return negative ? -magnitude : magnitude;
}

export function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICROS_SCALE;
  const frac = (abs % MICROS_SCALE).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function addMicros(a: bigint, b: bigint): bigint {
  return a + b;
}

export function subMicros(a: bigint, b: bigint): bigint {
  return a - b;
}

/** (a * b) / SCALE with round-half-up on the truncated remainder. */
export function mulMicros(a: bigint, b: bigint): bigint {
  const product = a * b;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + MICROS_SCALE / 2n) / MICROS_SCALE;
  return negative ? -rounded : rounded;
}

/** amount * numerator / denominator with round-half-up. Denominator must be nonzero. */
export function mulRatio(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('mulRatio denominator is zero');
  const product = amount * numerator;
  const negative = (product < 0n) !== (denominator < 0n) && product !== 0n;
  const absProd = product < 0n ? -product : product;
  const absDen = denominator < 0n ? -denominator : denominator;
  const rounded = (absProd + absDen / 2n) / absDen;
  return negative ? -rounded : rounded;
}

export function absMicros(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function maxMicros(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
