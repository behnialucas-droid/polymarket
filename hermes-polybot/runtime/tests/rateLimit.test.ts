/**
 * Rate Limiter Tests — Foundation v2 Phase 2 Verification
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, limiterFor } from '../src/lib/adapters/rateLimit.ts';

test('RateLimiter — serial admission and max concurrent cap', async () => {
  const limiter = new RateLimiter({ minIntervalMs: 20, maxConcurrent: 3, jitterMs: 0 }, 'test-host');
  let currentInFlight = 0;
  let maxObservedInFlight = 0;

  const t0 = Date.now();
  const tasks = Array.from({ length: 15 }, async (_, i) => {
    return limiter.schedule(async () => {
      currentInFlight++;
      maxObservedInFlight = Math.max(maxObservedInFlight, currentInFlight);
      await new Promise((r) => setTimeout(r, 10)); // 10ms work
      currentInFlight--;
      return i;
    });
  });

  const results = await Promise.all(tasks);
  const elapsed = Date.now() - t0;

  // 15 requests at 20ms interval minimum => at least 280ms total
  assert.ok(elapsed >= 250, `Expected elapsed >= 250ms, got ${elapsed}ms`);
  assert.ok(maxObservedInFlight <= 3, `Expected max in-flight <= 3, got ${maxObservedInFlight}`);
  assert.deepEqual(results, Array.from({ length: 15 }, (_, i) => i));
});

test('RateLimiter — poison test: exception in task does not break chain', async () => {
  const limiter = new RateLimiter({ minIntervalMs: 10, maxConcurrent: 2, jitterMs: 0 }, 'poison-test');

  // Task 1 fails
  const p1 = limiter.schedule(async () => {
    throw new Error('boom');
  }).catch((e) => e.message);

  // Task 2 succeeds
  const p2 = limiter.schedule(async () => 'ok');

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1, 'boom');
  assert.equal(res2, 'ok');
});

test('RateLimiter — noteThrottle cooldown delays execution', async () => {
  const limiter = new RateLimiter({ minIntervalMs: 10, maxConcurrent: 2, jitterMs: 0 }, 'cooldown-test');
  
  // Inject a 1-second throttle
  limiter.noteThrottle(1);

  const t0 = Date.now();
  await limiter.schedule(async () => 'done');
  const elapsed = Date.now() - t0;

  assert.ok(elapsed >= 900, `Expected elapsed >= 900ms due to 1s cooldown, got ${elapsed}ms`);
});

test('limiterFor — registry returns singleton per host', () => {
  const l1 = limiterFor('api.test.com');
  const l2 = limiterFor('api.test.com');
  assert.strictEqual(l1, l2);
});
