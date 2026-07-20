import { env, log } from './env.ts';

// Fallback to SMC Bot tokens if .env is missing them
const FALLBACK_TOKEN = '8233036914:AAF699ijYWDwJebEKu__CH6QUrNvLx2TPnA';
const FALLBACK_CHAT = '5708853617';

export async function sendTelegram(message: string, maxRetries = 3): Promise<void> {
  const token = env.telegramToken() || FALLBACK_TOKEN;
  const chatId = env.telegramChatId() || FALLBACK_CHAT;

  if (!token || !chatId) {
    log('[TG] Missing credentials, skipping message:', message.slice(0, 50));
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  log(`[TG] Sending message (length: ${message.length})`);
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 15000); // 15s timeout

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
        signal: abortController.signal
      });
      
      clearTimeout(timeoutId);

      if (res.ok) {
        return; // success
      }
      
      const data = await res.json().catch(() => ({}));
      log(`[TG ERROR] API returned: ${JSON.stringify(data)}`);
    } catch (e: any) {
      log(`[TG ERROR attempt ${attempt + 1}] ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); // backoff 3s, 6s, 9s
    }
  }
}
