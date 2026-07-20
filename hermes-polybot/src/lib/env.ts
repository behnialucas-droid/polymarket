/** Env access + secret redaction. NO private keys are ever read or stored. */

const SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'API_KEY'];

export const env = {
  dataSource: (): 'demo' | 'live' => (process.env.DATA_SOURCE === 'demo' ? 'demo' : 'live'),
  telegramToken: (): string | undefined => process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: (): string | undefined => process.env.TELEGRAM_CHAT_ID,
};

/** Redact anything that looks like a secret before logging or rendering. */
export function redact(text: string): string {
  let out = text;
  for (const k of SECRET_KEYS) {
    const v = process.env[k];
    if (v && v.length > 3) out = out.split(v).join('[REDACTED]');
  }
  // generic token-looking strings
  out = out.replace(/\b\d{6,10}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]'); // telegram tokens
  out = out.replace(/\b0x[a-fA-F0-9]{64}\b/g, '[REDACTED]'); // 32-byte hex (private-key shaped)
  return out;
}

export function log(...args: unknown[]): void {
  console.log(...args.map((a) => (typeof a === 'string' ? redact(a) : a)));
}
