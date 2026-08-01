import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMicros, fromMicros, mulMicros, mulRatio, absMicros } from '../src/lib/engine/decimal.ts';

test('toMicros parses NUMERIC strings exactly and round-trips', () => {
  assert.equal(toMicros('0'), 0n);
  assert.equal(toMicros('1'), 1_000_000n);
  assert.equal(toMicros('12.345678'), 12_345_678n);
  assert.equal(toMicros('-3.5'), -3_500_000n);
  assert.equal(fromMicros(toMicros('1234567.891011')), '1234567.891011');
  // 7th decimal digit rounds half-up
  assert.equal(toMicros('0.00000049'), 0n);
  assert.equal(toMicros('0.00000050'), 1n);
});

test('toMicros accepts finite numbers and rejects garbage', () => {
  assert.equal(toMicros(0.1), 100_000n);
  assert.equal(toMicros(19.99), 19_990_000n);
  assert.throws(() => toMicros('12,5'));
  assert.throws(() => toMicros('1e6'));
  assert.throws(() => toMicros(Number.NaN));
  assert.throws(() => toMicros(Number.POSITIVE_INFINITY));
});

test('sums that break IEEE floats stay exact in micros', () => {
  // 0.1 + 0.2 !== 0.3 in float; exact in micros
  assert.equal(toMicros('0.1') + toMicros('0.2'), toMicros('0.3'));
  let total = 0n;
  for (let i = 0; i < 1000; i++) total += toMicros('0.001');
  assert.equal(total, toMicros('1'));
});

test('mulMicros and mulRatio round half-up and keep sign', () => {
  assert.equal(mulMicros(toMicros('2'), toMicros('0.5')), toMicros('1'));
  assert.equal(mulMicros(toMicros('10'), toMicros('0.6')), toMicros('6'));
  assert.equal(mulMicros(toMicros('-10'), toMicros('0.6')), toMicros('-6'));
  assert.equal(mulRatio(toMicros('10'), 1n, 3n), 3_333_333n);
  assert.equal(mulRatio(toMicros('10'), 2n, 3n), 6_666_667n);
  assert.throws(() => mulRatio(1n, 1n, 0n));
  assert.equal(absMicros(-5n), 5n);
});
