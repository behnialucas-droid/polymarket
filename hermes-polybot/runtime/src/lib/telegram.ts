/**
 * Telegram delivery — Foundation v2 §10
 *
 * Rules:
 *  - ONE bot identity. No fallback token, ever. Missing config = loud crash.
 *  - Everything routed through redact() before sending.
 *  - Report always sends even when the watchdog found problems.
 *  - Failure to send is a JOB failure (throws).
 *  - Messages split on line boundaries; hard-cut only when a single line > 4096.
 *  - parse_mode: 'HTML' (not MarkdownV2 — wallet addresses contain underscores
 *    and other characters that require escaping 18 characters in MarkdownV2;
 *    one missed escape returns 400 and kills the entire report).
 */

import { required, redact } from './env.ts';

const MAX_LEN = 4096;
const API = 'https://api.telegram.org';

export interface SendOptions {
  silent?: boolean;
}

/**
 * Send a Telegram message. Splits if > 4096 chars.
 * Throws on permanent failure (4xx other than 429, or > 4 retries).
 */
export async function sendTelegram(text: string, opts: SendOptions = {}): Promise<void> {
  const token  = required('TELEGRAM_BOT_TOKEN');   // throws if unset — intended
  const chatId = required('TELEGRAM_CHAT_ID');

  for (const part of splitMessage(redact(text), MAX_LEN)) {
    await sendOne(token, chatId, part, opts.silent ?? false);
  }
}

async function sendOne(
  token: string,
  chatId: string,
  text: string,
  silent: boolean,
): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: silent,
        }),
      });
    } catch (error: unknown) {
      if (attempt < 4) {
        await sleep(1_000 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`telegram send failed after 4 attempts: ${redact(error)}`);
    }

    if (res.ok) return;

    const body = await res.text().catch(() => '');

    // Telegram rate limit — obey retry_after exactly
    if (res.status === 429) {
      let wait = 5;
      try { wait = JSON.parse(body)?.parameters?.retry_after ?? 5; } catch { /* keep default */ }
      await sleep(wait * 1_000);
      continue;
    }

    // Transient server errors — exponential back-off
    if (res.status >= 500 && attempt < 4) {
      await sleep(1_000 * 2 ** (attempt - 1));
      continue;
    }

    // 400 = malformed HTML entity or invalid params
    // 401 = revoked token  403 = bot blocked or never started by chat
    // None of these are retryable. Fail loudly.
    throw new Error(
      `telegram send failed: HTTP ${res.status} ${redact(body)}`
    );
  }
  throw new Error('telegram send failed after 4 attempts');
}

/**
 * Split on line boundaries; only hard-cut a single line that is itself > max.
 */
function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > max) {
      if (buf) out.push(buf);
      buf = line.length > max ? '' : line;
      if (line.length > max) {
        for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * HTML parse_mode: escape exactly these three characters.
 * Use on every user-supplied string (wallet addresses, reasons, error text).
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
