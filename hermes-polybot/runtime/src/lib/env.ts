/**
 * Centralised env access and redaction.
 *
 * Rules (from Foundation v2 §0.4):
 *   required(key)  — throws if unset or empty. Used for every secret.
 *   optional(key)  — returns undefined when unset (never throws).
 *   num(key, def)  — parses integer; returns `def` when unset.
 *   bool(key, def) — parses 'true'/'1'/'yes'; returns `def` when unset.
 *   redact(v)      — scrubs known secrets from any value before logging/sending.
 *
 * There is NO fallback logic. A missing secret must crash loudly.
 * A Telegram message is a log you cannot delete — route EVERYTHING through redact().
 */

/** Patterns that match a secret value and must be replaced in output. */
const SECRET_PATTERNS: RegExp[] = [
  /postgresql:\/\/[^:]+:[^@]{8,}@/gi,           // Postgres URLs with passwords
  /\b[0-9]{8,12}:AA[A-Za-z0-9_-]{33,}\b/g,      // Telegram bot tokens
  /ghp_[A-Za-z0-9]{36}/g,                        // GitHub personal access tokens (classic)
  /github_pat_[A-Za-z0-9_]{82}/g,                // GitHub fine-grained PATs
  /gho_[A-Za-z0-9]{36}/g,                        // GitHub OAuth tokens
  /ghs_[A-Za-z0-9]{36}/g,                        // GitHub Actions tokens
  /\b[A-Z0-9]{20}(?=[^A-Z]|$)/g,                 // AWS access key IDs
  /\b[A-Za-z0-9+/]{40}\b/g,                      // AWS secret keys (approximate)
  /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/g,
];

/** Live secret values to scrub from output (populated lazily at first use). */
let _liveValues: string[] | null = null;

function getLiveValues(): string[] {
  if (_liveValues) return _liveValues;
  const candidates = [
    process.env['DATABASE_URL'],
    process.env['DIRECT_URL'],
    process.env['TELEGRAM_BOT_TOKEN'],
    process.env['WORKFLOW_DISPATCH_TOKEN'],
  ];
  _liveValues = candidates.filter((v): v is string => typeof v === 'string' && v.length > 8);
  return _liveValues;
}

/**
 * Redact secrets from any string or error object before logging or sending.
 * Always pass log/Telegram output through this.
 */
export function redact(value: unknown): string {
  let s: string;
  if (typeof value === 'string') {
    s = value;
  } else if (value instanceof Error) {
    s = `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  } else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }

  // Replace live values first (most specific)
  for (const live of getLiveValues()) {
    s = s.split(live).join('[REDACTED]');
  }
  // Then replace by pattern
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, '[REDACTED]');
  }
  return s;
}

/**
 * Retrieve a required environment variable. Throws if absent or empty.
 * Use for every credential and connection string.
 */
export function required(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    throw new Error(
      `FATAL: required environment variable ${key} is not set. ` +
      `Check GitHub Actions secrets or your .env file.`
    );
  }
  return v;
}

/**
 * Retrieve an optional environment variable.
 * Returns undefined when unset. Use for non-critical config.
 */
export function optional(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

/**
 * Retrieve an env var as a positive integer.
 * Returns `defaultValue` when the key is unset or non-numeric.
 */
export function num(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric env var ${key}="${v}" — must be an integer.`);
  }
  return n;
}

/**
 * Retrieve an env var as a boolean.
 * 'true', '1', 'yes' (case-insensitive) → true. Anything else → false.
 * When unset, returns `defaultValue`.
 */
export function bool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  return /^(true|1|yes)$/i.test(v);
}
