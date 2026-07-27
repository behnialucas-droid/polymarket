/**
 * HTTP client with per-host rate limiting — Foundation v2 Phase 2
 *
 * All Polymarket API calls route through getJson() here.
 * Never call fetch() directly from adapters.
 */

import { limiterFor } from './rateLimit.ts';
import { redact } from '../env.ts';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fetch JSON from `url`, routed through the per-host RateLimiter.
 *
 * Retries on: 408 (timeout), 425 (too early), 429 (rate limit), 5xx
 * Does NOT retry on: 4xx client errors (except above)
 */
export async function getJson<T = unknown>(
  url: string,
  opts: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxRetries?: number;
  } = {}
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = 6, headers = {} } = opts;

  const host = new URL(url).hostname;
  const limiter = limiterFor(host);

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential back-off between retries: 1s, 2s, 4s, 8s, 16s
      await sleep(1_000 * 2 ** (attempt - 1));
    }

    const result = await limiter.schedule(async () => {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'HermesPolybot/2.0 (github.com/behnialucas-droid/polymarket)',
            ...headers,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e: unknown) {
        // Network error or timeout — retryable
        throw Object.assign(
          new Error(`Network error fetching ${redact(url)}: ${(e as Error)?.message ?? e}`),
          { retryable: true }
        );
      }

      if (res.ok) {
        limiter.noteSuccess();
        try {
          return { ok: true as const, data: (await res.json()) as T };
        } catch (e: unknown) {
          throw new Error(`JSON parse error from ${redact(url)}: ${(e as Error)?.message}`);
        }
      }

      const body = await res.text().catch(() => '');

      // Rate limited — honour Retry-After, trigger limiter cooldown
      if (res.status === 429) {
        let retryAfter = 5;
        try {
          const parsed = JSON.parse(body);
          retryAfter = parsed?.parameters?.retry_after ?? retryAfter;
        } catch { /* keep default */ }
        const headerVal = res.headers.get('Retry-After');
        if (headerVal) retryAfter = Math.max(retryAfter, parseInt(headerVal, 10) || 5);

        limiter.noteThrottle(retryAfter);
        console.warn(`[${host}] HTTP 429 — cooling down ${retryAfter}s`);
        return { ok: false as const, retryable: true };
      }

      // Retryable transient errors
      if ([408, 425, 503, 504, 502, 500].includes(res.status)) {
        return {
          ok: false as const,
          retryable: true,
          err: new Error(`HTTP ${res.status} fetching ${redact(url)}: ${body.slice(0, 200)}`),
        };
      }

      // Non-retryable client error
      throw new Error(
        `HTTP ${res.status} ${res.statusText} fetching ${redact(url)}: ${body.slice(0, 200)}`
      );
    }).catch((e: unknown) => {
      const err = e as Error & { retryable?: boolean };
      if (err.retryable) return { ok: false as const, retryable: true, err };
      throw err; // non-retryable: propagate immediately
    });

    if ('data' in result && result.ok) return result.data;
    if ('err' in result && result.err) lastErr = result.err;
    // else: 429 cooldown handled by limiter, just retry
  }

  throw lastErr ?? new Error(`Failed to fetch ${redact(url)} after ${maxRetries} retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
