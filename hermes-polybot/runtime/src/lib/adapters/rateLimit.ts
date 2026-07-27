/**
 * Per-host rate limiter — Foundation v2 Phase 2
 *
 * Fixes two bugs in the original polymarket.ts:
 *   1. `lastRequestTime` was a module-level number read and written across
 *      await boundaries — a classic TOCTOU race that lets bursts fire.
 *   2. No concurrency cap — Promise.all over all wallets produced unbounded
 *      simultaneous in-flight requests sharing the same host limiter.
 *
 * The fix is a serialised promise chain (a "ticket queue") for admission
 * plus a counting semaphore for concurrency.  Both operate on Promises,
 * so they are race-free in JavaScript's single-threaded event loop.
 *
 * Additional features:
 *   - Exponential-decay global cooldown triggered by 429 responses
 *     (Cloudflare and the Poly CLOB throttle softly, not hard-reject)
 *   - Latency-based backoff: if P99 latency exceeds a threshold, slow down
 *   - allLimiterStats() exposes telemetry for heartbeat payloads
 */

export interface RateLimiterConfig {
  /** Minimum milliseconds between successive requests (serialised queue). */
  minIntervalMs: number;
  /** Maximum simultaneous in-flight requests. */
  maxConcurrent: number;
  /** Random jitter added to each interval (0–jitterMs). Set 0 for tests. */
  jitterMs?: number;
  /** If P99 latency (ms) exceeds this, add an extra back-off period. */
  latencyThresholdMs?: number;
  /** Back-off duration when latency threshold is exceeded (ms). */
  latencyBackoffMs?: number;
}

export interface LimiterStats {
  host: string;
  inFlight: number;
  queueDepth: number;
  totalRequests: number;
  totalThrottles: number;
  cooldownUntil: number;
  p99LatencyMs: number;
}

export class RateLimiter {
  private readonly cfg: Required<RateLimiterConfig>;
  private readonly host: string;

  /** Serialised promise chain — the tail is the "ticket" every caller awaits. */
  private admissionTail: Promise<void> = Promise.resolve();
  /** Counting semaphore — released when a request finishes. */
  private inFlight = 0;
  private semaphoreTail: Promise<void> = Promise.resolve();

  /** Cooldown: all requests block until this timestamp. */
  private cooldownUntil = 0;
  /** Cooldown multiplier — doubles on each consecutive 429, decays otherwise. */
  private cooldownMultiplier = 1;

  /** Rolling latency window for P99 estimation. */
  private readonly latencyWindow: number[] = [];
  private readonly LATENCY_WINDOW_SIZE = 50;

  // Telemetry
  private totalRequests = 0;
  private totalThrottles = 0;
  private queueDepth = 0;

  constructor(cfg: RateLimiterConfig, host = 'default') {
    this.cfg = {
      jitterMs: 50,
      latencyThresholdMs: 3_000,
      latencyBackoffMs: 500,
      ...cfg,
    };
    this.host = host;
  }

  /**
   * Schedule `fn` to run through the rate limiter.
   * Returns the resolved value of `fn`.
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    this.queueDepth++;

    // --- Admission gate (serialised, min-interval enforced) ---
    const myTicket = this.admissionTail.then(async () => {
      // Wait out any active cooldown first
      const now = Date.now();
      if (this.cooldownUntil > now) {
        await sleep(this.cooldownUntil - now);
      }

      // Jitter
      const jitter = this.cfg.jitterMs > 0
        ? Math.random() * this.cfg.jitterMs
        : 0;
      await sleep(this.cfg.minIntervalMs + jitter);
    });
    // The next caller's ticket awaits THIS ticket completing — serial queue.
    this.admissionTail = myTicket.catch(() => {/* swallow so chain continues */});
    await myTicket;

    // --- Concurrency semaphore ---
    while (this.inFlight >= this.cfg.maxConcurrent) {
      await this.semaphoreTail;
    }

    this.queueDepth--;
    this.inFlight++;
    this.totalRequests++;
    const t0 = Date.now();

    // Release slot after fn completes (success or failure)
    let resolveSlot!: () => void;
    this.semaphoreTail = new Promise<void>((r) => { resolveSlot = r; });

    try {
      return await fn();
    } finally {
      const latency = Date.now() - t0;
      this.recordLatency(latency);

      // Latency-based backoff
      if (latency > this.cfg.latencyThresholdMs) {
        await sleep(this.cfg.latencyBackoffMs);
      }

      this.inFlight--;
      resolveSlot();
    }
  }

  /**
   * Record a 429 response. Triggers exponential-decay global cooldown.
   * Call from the HTTP layer when a 429 is received.
   */
  noteThrottle(retryAfterSeconds = 5): void {
    this.totalThrottles++;
    const waitMs = Math.max(retryAfterSeconds * 1_000, 1_000) * this.cooldownMultiplier;
    this.cooldownUntil = Date.now() + waitMs;
    this.cooldownMultiplier = Math.min(this.cooldownMultiplier * 2, 32);
  }

  /** Call after a successful request to decay the cooldown multiplier. */
  noteSuccess(): void {
    if (this.cooldownMultiplier > 1) {
      this.cooldownMultiplier = Math.max(1, this.cooldownMultiplier * 0.5);
    }
  }

  snapshot(): LimiterStats {
    return {
      host: this.host,
      inFlight: this.inFlight,
      queueDepth: this.queueDepth,
      totalRequests: this.totalRequests,
      totalThrottles: this.totalThrottles,
      cooldownUntil: this.cooldownUntil,
      p99LatencyMs: this.p99(),
    };
  }

  private recordLatency(ms: number): void {
    this.latencyWindow.push(ms);
    if (this.latencyWindow.length > this.LATENCY_WINDOW_SIZE) {
      this.latencyWindow.shift();
    }
  }

  private p99(): number {
    if (this.latencyWindow.length === 0) return 0;
    const sorted = [...this.latencyWindow].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.99);
    return sorted[Math.min(idx, sorted.length - 1)];
  }
}

// ----------------------------------------------------------------
// Per-host limiter registry
// ----------------------------------------------------------------

const _limiters = new Map<string, RateLimiter>();

/** Default configs per Polymarket host (from audit §3.3). */
const HOST_CONFIGS: Record<string, RateLimiterConfig> = {
  'gamma-api.polymarket.com': {
    minIntervalMs: 200,  // 5 req/s sustained
    maxConcurrent: 5,
  },
  'data-api.polymarket.com': {
    minIntervalMs: 70,   // 150 req/10s = ~14/s; 70ms gives headroom
    maxConcurrent: 5,
  },
  'clob.polymarket.com': {
    minIntervalMs: 200,
    maxConcurrent: 3,
  },
  'default': {
    minIntervalMs: 200,
    maxConcurrent: 5,
  },
};

/**
 * Get (or create) the RateLimiter for a given hostname.
 * Env vars PM_MIN_INTERVAL_MS and PM_MAX_CONCURRENT override defaults.
 */
export function limiterFor(host: string): RateLimiter {
  if (_limiters.has(host)) return _limiters.get(host)!;

  const defaults = HOST_CONFIGS[host] ?? HOST_CONFIGS['default'];
  const minIntervalMs = parseInt(process.env['PM_MIN_INTERVAL_MS'] ?? '0', 10) || defaults.minIntervalMs;
  const maxConcurrent = parseInt(process.env['PM_MAX_CONCURRENT'] ?? '0', 10) || defaults.maxConcurrent;

  const limiter = new RateLimiter({ minIntervalMs, maxConcurrent }, host);
  _limiters.set(host, limiter);
  return limiter;
}

/** Return stats for all active limiters (for heartbeat telemetry). */
export function allLimiterStats(): LimiterStats[] {
  return [..._limiters.values()].map((l) => l.snapshot());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
